# Icons and icon sets

Create icons that communicate their subject or action through a clear silhouette, balanced composition and deliberate use of color and material. Match the visual tone of the product. In a family, make each icon individually recognizable and visibly related to its neighbors.

## Choose the visual language and medium

Use the brief and existing product to understand what the icon means and how it should feel. A quiet interface symbol, an expressive illustration and a sculptural app icon call for different treatment. Honor the requested format and use the construction method that can carry that treatment well.

- **Familiar UI symbols:** reuse the project's icon library or platform symbols when suitable. For an original SVG, construct simple geometry directly; image generation adds little to a standard arrow, close button or bookmark.
- **Illustrated vector icons:** use SVG when editable contours, layered shapes, solid fills or a few designed gradients carry the appearance. A reference can establish a distinctive silhouette, palette and arrangement.
- **Dimensional or material-rich icons:** use a Blender scene and rendered PNGs when volume, reflections, lighting or multiple views are central. Build connected parts with real depth, and use camera and lighting choices that make their forms read clearly.
- **Raster artwork:** use image generation when the user needs a finished image without editable geometry or a repeatable scene.

For a custom design, use supplied examples to establish the style. Generate a reference when it would help explore the subject or visual language. For a new family, settle the treatment with a few representative members before expanding the set. Follow the target platform's masking and export conventions; app icons and in-app glyphs can need different containers and treatments.

## Develop the design

Keep the reference prompt close to the user's brief, adding the chosen visual treatment and isolation when useful. Ask for the finished icon itself. Interface mockups, incidental lettering and decorative surroundings belong only when requested.

Make the defining object or action easy to read. Secondary objects should clarify its meaning and form a deliberate composition. Choose detail that gives the design character: a recognizable contour, a material cue or a well-placed highlight can do more than many tiny marks. A larger reference helps inspect those choices; it need not introduce extra complexity.

Use light and shade to explain form. A luminous rim, soft contact shadow or tonal surround can separate adjacent parts and make an object feel solid. Preserve its placement, extent and contrast when it carries that structure. A hard outline is not an equivalent substitute. Flat fills are equally valid when they express the intended design.

## Construct the icon and its family

Build the defining shapes and their connections before polishing the surface. Follow an illustrated object's main part through its joints to its support, with plausible attachments and clear occlusion. Preserve that structure as the design becomes simpler.

For a family, keep a shared palette, apparent weight, corner treatment and amount of detail. In SVG, coordinate viewBoxes, strokes, caps, joins and filled versus outlined areas. In Blender, share camera projection and angle, framing, material treatment, lighting direction and shadow softness. A reusable scene setup helps maintain that relationship.

Balance size and weight optically: a narrow tool, circle and broad container may need different occupied bounds to feel equal. Preserve useful interior gaps and a clear silhouette. Fit the artwork to its container while distinguishing its bounds from the surrounding control or touch target. Use `currentColor` for monochrome symbols intended to follow text color.

Work through a simple member and a difficult silhouette or overlap before repeating a technique across a set. For small SVGs, account for stroke centering, clipping and raster alignment without snapping every curved point to a grid. Finish open ends deliberately and keep neighboring strokes from fusing.

## Review in context

Evaluate the icon where it will be used, at the intended display sizes and backgrounds. Check recognition without relying on a filename or label, and compare family members for distinct meanings, apparent weight, alignment and detail density. Native-size views reveal readability; enlarged views reveal faulty contours, joints and overlaps. Matched crops or a contact sheet can help this review without becoming additional delivery requirements.

Compare the separation between forms after downsampling. If a rim, shadow or tonal surround disappears, the object may flatten or merge with its neighbors even while remaining recognizable. Tune the cue or simplify competing marks. Make a size-specific variant when uniform scaling cannot preserve the intended design at a required size. Judge the actual exported result rather than a zoomed-out working canvas.

For reference-guided SVGs, apply the fidelity rubric to the icon's meaning and visual language. Its volume criterion judges the intended layering and edge treatment; it does not require adding gradients to a flat design. Directly drawn symbols need recognition, geometry, consistency and rendering checks without an invented reference. For Blender, compare the final camera render with the reference, then inspect another angle for false depth, floating parts and hidden intersections.

When integrating icons into controls, preserve accessible names in the surrounding UI as well as visual recognition.

## Deliver the requested assets

For SVG, provide individual editable files with consistent naming. Verify family members together, including gradient and clip IDs that could collide when embedded inline. Apply the [SVG export checks](../SKILL.md#svg-export-and-editability-checks) using dimensions and pixel density chosen for the actual use before construction. If one SVG serves several required sizes, check each corresponding PNG; a contact sheet or artificially enlarged export is not its counterpart. If a small PNG is smaller than even economical SVG markup, report the conflict rather than removing defining strokes to manufacture a pass.

For Blender, provide the editable scene and requested PNG exports. Name objects and materials so an icon can be recolored or revised without rebuilding the family. Check the final PNGs on their intended backgrounds, including alpha edges. The SVG-versus-PNG byte ceiling does not apply to scene files or raster-only icons.

Include a useful preview with the requested assets. Review sheets and enlarged diagnostics are working aids; deliver them when requested or when they help explain a remaining issue.
