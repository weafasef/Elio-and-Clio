---
name: image-guided-svg-3d
description: Use when a visual reference would improve an SVG illustration, custom icon or original 3D asset, or when creating functional 3D parts with dimensions, fit or parametric CAD.
---

# Image-guided SVG and 3D assets

Build editable geometry suited to the requested asset, using visual references when they help resolve appearance.

## Choose the workflow

Start from the intended use, requested format and existing project. For custom icons and icon families, read [iconography](references/iconography.md) to choose the visual language and medium.

- **SVG:** use designed contours, layered shapes and broad shading. Follow [SVG construction and export](#constructing-svg).
- **Visual or sculpted 3D:** prefer Blender when no tool is specified. Follow [3D construction](#constructing-visual-3d) for editable geometry, materials and renders.
- **Functional 3D:** use parametric CAD when dimensions, fit or mechanical relationships define the object. Follow [physical design](references/physical-design.md) from requirements through delivery.

A printable figurine can still suit Blender; apply the [fabrication checks](references/physical-design.md#check-fabrication) to any object intended for manufacture. The SVG byte ceiling and fidelity rubric apply only to SVG.

Use the reference stages below when an image will help establish the design. Reuse suitable UI symbols and build simple geometry or fully specified dimensional parts directly. If the user needs only a raster image, image generation can be the deliverable.

## Develop a useful reference

Reuse a supplied reference when it serves the request. Otherwise, generate one from the user's brief, adding only useful constraints for the chosen medium. Use transparency for cutouts and a plain background otherwise, unless a setting is requested or intrinsic to the asset. If generation is unavailable and a reference is necessary, request one or explain the limits of direct construction.

For a photo or scan of flat artwork, reconstruct the intended design unless a literal facsimile is requested. Remove effects attributable to the paper or camera while preserving the depicted objects' contours, shading and material detail.

For SVG, read [reference design](references/svg-reference-design.md) before generating. Aim for a finished vector design at approximately the detail the asset should retain: expressive contours, layered forms and useful broad shading. For Blender, the reference can use depth, materials and lighting that a scene can reproduce. Keep reference prompts short and grounded in the user's request.

Inspect the reference for coherent forms and spatial relationships. Resolve consequential ambiguity in a generated reference before building, preserving unaffected choices and keeping additional views consistent. For transparent references, inspect actual alpha composites before judging a background or halo; hidden RGB can look opaque in a viewer. The user's requirements take precedence over the reference.

## Build from the reference

Establish the silhouette, proportions, perspective and overlaps, then construct the focal features that give the design its identity. Preserve their characteristic angles, spacing and negative spaces. For repeated forms, work through a typical part and an important variation before extending the method across the composition.

Render these representative regions in context and compare them with the reference. Once the construction works, complete the asset and compare the whole composition at matching scale and framing. Use enlarged crops to diagnose a mismatch and intended-size views to judge its effect.

Save a known-good render before repairs. Correct the most consequential visible difference with a local edit, then re-render the affected region and the whole asset. Keep improvements that preserve already-correct structure and clean contours. If a method keeps losing the same feature, change the construction. Make an available, concrete repair before finalizing rather than replacing it with a limitations note. Test a representative edit in the saved asset.

## Constructing SVG

For reference-guided SVGs, use [the fidelity rubric](references/svg-fidelity-rubric.md) to plan attention and judge the result. Read [contour and surface construction](references/svg-construction.md) when fitting detailed outlines or when gradients, folds, layered forms or contact shadows carry the volume. Directly drawn symbols instead need clear recognition, sound geometry, family consistency and clean rendering.

Build with economical paths, shapes, strokes, gradients and meaningful groups. Reuse geometry where the design repeats. Keep the result editable: do not embed the reference, simulate pixels with dense tiles or default to a dense full-image trace. Direct curves and selective contour fitting are both useful; fragmented shading usually needs a few designed surfaces and fields.

Carry the main light/dark and warm/cool relationships into the first construction. Preserve broad gradients and selective highlights when they define volume, material or atmosphere. Resolve each surface's contour and overlaps before fitting its interior shading. Simplify incidental texture and quiet regions before sacrificing focal character or distinctive variation.

### SVG export and editability checks

Choose delivery dimensions and pixel density from the intended use before construction. **The final uncompressed SVG must be no larger than the actual PNG rendered from it at those dimensions**, and must honor any smaller user limit. Use normal lossless PNG compression with matching background/transparency. Do not enlarge or inflate the PNG to pass.

Re-render after edits, then run `python scripts/check_svg_budget.py final.svg final.png --width WIDTH --height HEIGHT` with resolved absolute asset paths, or an equivalent check. The helper validates the PNG export but cannot establish that it depicts the current SVG.

When over budget, remove redundant geometry, merge incidental marks, reuse repeated shapes and simplify quieter regions. Retain visible contour nuance, broad shading and distinctive secondary forms when space allows. If fidelity and the ceiling conflict, report the conflict rather than silently degrading the design or claiming success.

Check the `viewBox`, unique IDs and resolved references. Inspect small and large renders, and composite cutouts on contrasting backgrounds to check transparency. Use [the alpha helper](scripts/review_alpha.py) or an equivalent scan to investigate unintended gaps. A group move or recolor should keep its constituent shapes, shading and masks together. Report the SVG and PNG bytes and PNG dimensions; these practical checks remain separate from visual acceptance.

Resolve bundled paths relative to this `SKILL.md`. Command examples assume the skill directory is the working directory; both image-checking helpers require Pillow.

## Constructing visual 3D

Build editable geometry and materials, inferring unseen geometry where necessary for appearance. Give volumetric parts real depth and coherent connections, and match material texture scale and variation to the reference.

Align the camera using reference landmarks, then match lighting and reflected surroundings. Inspect other relevant angles for depth, connections and material problems. If using a shaded reference as a projected texture, check other angles and changed lighting for stretching and baked-in shading. For exports, bake unsupported procedural effects when they matter, then inspect the exported geometry and materials.

For rendered icons, judge the final camera at the intended display size and background as well as enlarged. Keep the scene editable, render the requested PNG sizes and preserve alpha when required.

## Deliver the result

Provide the saved editable asset and a useful rendered preview in the requested format. Name any unresolved visual or editing limitation and any check that could not be completed. For raster-only requests, deliver the image without adding an unwanted conversion.
