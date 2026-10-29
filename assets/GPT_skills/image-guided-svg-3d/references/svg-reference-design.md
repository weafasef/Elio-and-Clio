# Design a reference that transfers well to SVG

Aim for the finished vector artwork, with the character and depth the final SVG should preserve. A useful reference resolves the design in shapes and shading that can be rebuilt with little reinterpretation.

## Describe the drawing you want

Keep the prompt short. Lead with the user's subject and style, then describe the intended vector treatment: clear curved contours, large closed forms, purposeful overlaps, solid fills or broad smooth gradients. Put detail into distinctive shapes and selective focal accents. Let the brief determine the composition rather than inventing a catalog of props, colors, positions and effects.

Preserve useful depth through broad shading, local shadow contours and restrained highlights. Choose flat geometry when it suits the brief, and avoid unrequested dramatic lighting, glossy rendering or all-over texture. Flattening everything into hard color bands can lose as much character as an overly detailed reference.

For reflective glass or metal, describe an illustrative construction: deliberate reflection shapes, clear rims and broad tonal bands, with enough asymmetry and curved transitions to identify the material. For textured subjects, describe large groups such as feather layers, petal planes or grouped foliage. An approximate count can clarify a particular region, but there is no universal shape or color budget.

Translate a requested style into qualities that survive in vector form. For a painterly style, preserve palette, atmosphere and the rhythm of broad marks. Asking for a detailed painting and appending “vector-like” often leaves fragmented shading that needs substantial redesign. Explain a material stylistic compromise rather than implying identical brushwork.

## Decide whether the reference is ready

Inspect the generated image as a whole and in its defining regions. Plan how to retain the contours, layering, varied forms and main shading. Accept it when these can transfer with little redesign. Broad gradients and harmless raster artifacts do not by themselves justify regeneration.

Correct consequential anatomy errors, ambiguous overlaps or fragmented detail that would require extensive tracing. Keep the composition and character while resolving the specific problem. A user-supplied reference has different authority: preserve its design and requested fidelity, simplify incidental texture only as appropriate, and explain a genuine fidelity/representation conflict.

## Check transparency before changing the design

Judge cutouts through their alpha channel on actual backgrounds. Some viewers expose hidden RGB in fully transparent pixels as an apparent black background, colored halo or glow.

Before regenerating for a transparency complaint, composite the PNG on light and dark or checkerboard backgrounds. Use `python scripts/review_alpha.py reference.png --review reference-alpha.png` or an equivalent check. Invisible RGB is not a defect in the delivered asset. Correct visible background remnants or holes in intended solid parts, and assess texture or construction problems separately.
