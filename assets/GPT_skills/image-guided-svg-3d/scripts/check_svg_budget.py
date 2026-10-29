#!/usr/bin/env python3
"""Compare final SVG bytes with its PNG export; does not verify pixel correspondence."""

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from io import BytesIO
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit(
        "Pillow is required. Run this script with a Python environment that has Pillow installed."
    )


def check(svg_path, png_path, width, height):
    svg = Path(svg_path).read_bytes()
    png = Path(png_path).read_bytes()
    root = ET.fromstring(svg)
    if root.tag.rsplit("}", 1)[-1] != "svg":
        raise ValueError("SVG input is not an SVG document")
    # Pillow does not verify the terminal IEND checksum or require all its bytes.
    if not png.endswith(b"\x00\x00\x00\x00IEND\xae\x42\x60\x82"):
        raise ValueError("PNG export is missing its complete, valid IEND chunk")
    with Image.open(BytesIO(png)) as image:
        if image.format != "PNG":
            raise ValueError("PNG input is not a PNG image")
        actual = image.size
        image.verify()
    # verify() checks PNG chunks and checksums; load() also decodes image data.
    with Image.open(BytesIO(png)) as image:
        image.load()
    passed = actual == (width, height) and len(svg) <= len(png)
    return dict(
        svg_bytes=len(svg),
        png_bytes=len(png),
        svg_to_png_ratio=round(len(svg) / len(png), 4),
        png_width=actual[0],
        png_height=actual[1],
        expected_width=width,
        expected_height=height,
        dimensions_match=actual == (width, height),
        within_budget=len(svg) <= len(png),
        passed=passed,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("svg")
    parser.add_argument("png")
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    args = parser.parse_args()
    try:
        if args.width <= 0 or args.height <= 0:
            raise ValueError("Expected dimensions must be positive")
        result = check(args.svg, args.png, args.width, args.height)
    except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(2)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["passed"] else 1)
