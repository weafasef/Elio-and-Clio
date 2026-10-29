#!/usr/bin/env python3
"""List enclosed low-alpha regions for human review; never modify the input."""

import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit(
        "Pillow is required. Run this script with a Python environment that has Pillow installed."
    )


def components(alpha, width, height, threshold, min_area) -> tuple:
    """Row-span connected components; 8-connectivity, including diagonal joins."""
    # A lookup translates each alpha byte into a candidate bit. Scanning runs
    # avoids a large Python queue for the normally huge transparent exterior.
    bits = alpha.translate(bytes(int(value <= threshold) for value in range(256)))
    parents, areas, bounds, border = [], [], [], []

    def find(index) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(a, b) -> int:
        a, b = find(a), find(b)
        if a == b:
            return a
        if areas[a] < areas[b]:
            a, b = b, a
        parents[b] = a
        areas[a] += areas[b]
        left, top, right, bottom = bounds[a]
        bleft, btop, bright, bbottom = bounds[b]
        bounds[a] = [min(left, bleft), min(top, btop), max(right, bright), max(bottom, bbottom)]
        border[a] = border[a] or border[b]
        return a

    previous = []
    for y in range(height):
        row_start, row_end = y * width, (y + 1) * width
        position, scan, current = row_start, 0, []
        while position < row_end:
            start = bits.find(b"\x01", position, row_end)
            if start < 0:
                break
            end = bits.find(b"\x00", start, row_end)
            end = row_end if end < 0 else end
            left, right = start - row_start, end - row_start - 1
            while scan < len(previous) and previous[scan][1] < left - 1:
                scan += 1
            adjacent = scan
            label = None
            while adjacent < len(previous) and previous[adjacent][0] <= right + 1:
                neighbor = find(previous[adjacent][2])
                label = neighbor if label is None else union(label, neighbor)
                adjacent += 1
            if label is None:
                label = len(parents)
                parents.append(label)
                areas.append(0)
                bounds.append([left, y, right, y])
                border.append(False)
            label = find(label)
            areas[label] += right - left + 1
            bbox = bounds[label]
            bbox[0], bbox[2], bbox[3] = min(bbox[0], left), max(bbox[2], right), y
            border[label] = (
                border[label] or left == 0 or right == width - 1 or y == 0 or y == height - 1
            )
            current.append((left, right, label))
            position = end
        previous = current

    enclosed, exterior_count, filtered_count = [], 0, 0
    for i in range(len(parents)):
        if find(i) != i:
            continue
        if border[i]:
            exterior_count += 1
        elif areas[i] < min_area:
            filtered_count += 1
        else:
            enclosed.append({"bbox_inclusive_xyxy": bounds[i], "pixel_count": areas[i]})
    enclosed.sort(key=lambda c: (c["bbox_inclusive_xyxy"][1], c["bbox_inclusive_xyxy"][0]))
    for i, region in enumerate(enclosed, 1):
        region["id"] = i
    return enclosed, exterior_count, filtered_count


def make_review(image, regions, target) -> None:
    # Composite onto a checkerboard so both colored content and clear holes
    # remain visible. The saved review is a separate image, never the input.
    image = image.convert("RGBA")
    width, height = image.size
    scale = min(1.0, 1600 / max(width, height))
    if scale < 1:
        image = image.resize(
            (max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS
        )
    board = Image.new("RGB", image.size, (245, 245, 245))
    draw = ImageDraw.Draw(board)
    tile = 12
    for y in range(0, board.height, tile):
        for x in range(0, board.width, tile):
            if (x // tile + y // tile) % 2:
                draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=(205, 205, 205))
    board.paste(image, (0, 0), image.getchannel("A"))
    draw = ImageDraw.Draw(board)
    for region in regions:
        left, top, right, bottom = region["bbox_inclusive_xyxy"]
        left, top = round(left * scale), round(top * scale)
        right, bottom = round((right + 1) * scale) - 1, round((bottom + 1) * scale) - 1
        right, bottom = max(left + 3, right), max(top + 3, bottom)
        draw.rectangle((left - 2, top - 2, right + 2, bottom + 2), outline=(255, 25, 20), width=2)
        label = str(region["id"])
        labelbox = draw.textbbox((0, 0), label)
        label_width = labelbox[2] - labelbox[0]
        label_height = labelbox[3] - labelbox[1]
        lx = min(max(0, left - 2), max(0, board.width - label_width - 4))
        ly = max(0, top - label_height - 5)
        draw.rectangle((lx, ly, lx + label_width + 3, ly + label_height + 4), fill=(190, 10, 5))
        draw.text((lx + 2, ly - labelbox[1] + 2), label, fill=(255, 255, 255))
    board.save(target)


def same_file(first: Path, second: Path) -> bool:
    return first.resolve() == second.resolve() or (
        first.exists() and second.exists() and first.samefile(second)
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="List enclosed low-alpha PNG regions for human visual review (not automatic defects)."
    )
    parser.add_argument(
        "png", type=Path, help="already-rendered transparent PNG; input is never modified"
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=0,
        help="include alpha <= this value (0-254; default: 0, fully transparent only)",
    )
    parser.add_argument(
        "--min-area",
        type=int,
        default=1,
        help="minimum enclosed region area in pixels (default: 1)",
    )
    parser.add_argument("--json", type=Path, help="save JSON instead of printing it")
    parser.add_argument(
        "--review", type=Path, help="save an optional numbered, checkerboard review PNG"
    )
    args = parser.parse_args()
    if not 0 <= args.threshold <= 254:
        parser.error("--threshold must be between 0 and 254")
    if args.min_area < 1:
        parser.error("--min-area must be at least 1")
    paths = [args.png] + [p for p in (args.json, args.review) if p is not None]
    if any(same_file(path, other) for i, path in enumerate(paths) for other in paths[:i]):
        parser.error("input, JSON, and review output paths must be distinct")
    try:
        with Image.open(args.png) as image:
            if image.format != "PNG":
                parser.error("input must be an already-rendered PNG")
            if "A" not in image.getbands() and "transparency" not in image.info:
                parser.error(
                    "PNG has no alpha channel; render the SVG on a transparent background first"
                )
            rgba = image.convert("RGBA")
        width, height = rgba.size
        regions, exterior_count, filtered_count = components(
            rgba.getchannel("A").tobytes(), width, height, args.threshold, args.min_area
        )
        result = {
            "source": str(args.png),
            "dimensions": [width, height],
            "alpha_threshold_inclusive": args.threshold,
            "minimum_area_pixels": args.min_area,
            "connectivity": 8,
            "bbox_coordinates": "inclusive x_min,y_min,x_max,y_max",
            "border_connected_components_excluded": exterior_count,
            "enclosed_components_below_minimum_excluded": filtered_count,
            "review_candidates": regions,
            "note": "Candidates may be intentional openings; compare visually with the reference. No repair is performed.",
        }
        data = json.dumps(result, indent=2) + "\n"
        if args.json:
            args.json.write_text(data, encoding="utf-8")
        else:
            print(data, end="")
        if args.review:
            if args.json and same_file(args.json, args.review):
                parser.error("input, JSON, and review output paths must be distinct")
            make_review(rgba, regions, args.review)
    except (OSError, ValueError) as exc:
        sys.exit(f"Could not review PNG: {exc}")


if __name__ == "__main__":
    main()
