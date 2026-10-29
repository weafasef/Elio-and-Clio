# Judge reference-to-SVG fidelity

Use this rubric to decide where to spend attention and which visible mismatch to repair next. Compare the saved SVG's actual render with the intended artwork in the accepted reference at matching scale and framing. The goal is to preserve the design's identity and appearance with practical editable geometry.

## Separate the artwork from its capture

For photographed or scanned flat artwork, distinguish designed shapes, color fields and texture from paper edges, skew, scratches, wrinkles, glare and uneven capture lighting. Omit those capture artifacts in a clean reconstruction unless the user requests a literal reproduction. Broad shading from wrinkled paper is still a capture artifact; its size does not make it important. Preserve deliberate distress and texture that defines a depicted material. Apply this distinction consistently during construction and grading: successful cleanup is not missing detail.

Identify which surface owns a questionable cue. A crease or shadow continuing across unrelated depicted objects may belong to the photographed sheet; a bevel, screen inset or highlight that follows the depicted object's form belongs to that object. Remove capture effects locally. A cleaner background does not justify flattening a device, erasing its rim or smoothing away a real silhouette bend. Recheck those retained details after cleanup.

## Identify what gives the design its character

Identify the defining silhouette, focal features and main light/dark or warm/cool regions. Locate useful landmarks: tips, extrema, joins, inflections and overlap boundaries. Include small features that explain identity or physical contact, such as an eye or gripping toes. Distinguish designed color regions from incidental grain.

Allocate attention by meaning and visibility. A small eye, opening or join can matter more than a large quiet surface. For each important region, resolve its boundary, what overlaps it and how light varies within it, in that order.

For a hand gripping an object or a foot resting on a support, follow the visible parts through their joints and contact. Compare the thumb or toe placement, bends, gaps and which part passes in front. Preserve what is visible rather than inventing hidden digits or replacing the pose with a generic hand. Match the reference's grouping and spacing of hair or other irregular edges; use uniform spikes only when the design calls for them.

Treat a prop that explains the subject or action as a defining feature, even when small. Compare its orientation, thickness, visible faces, rims, controls and connections where these are legible in the reference. A device, earpiece or tool should retain its particular construction and how it is held or attached. Preserve designed details without inventing unreadable markings; recognition alone does not establish fidelity.

Before awarding identity and contact a 3, compare the geometry of each defining prop in a matched crop. The presence of its parts does not establish that their proportions, placement and connections match.

For repeated forms, compare a typical instance with visibly different ones before deciding what to reuse. A frontal flower, an oblique flower and a bud may share a palette while needing different contours and overlaps. Ornament deserves priority when it defines the design.

Read the interior of each form as well as its outline. A curved ridge, fold or crease may divide a leaf, petal, feather or fabric surface into differently lit planes. Preserve its route and the color progression on both sides. One smooth fill can retain the silhouette while losing this volume.

## Grade the visible result

Judge intended-size appearance first, then enlarge a region to diagnose the cause. Grade the consequence for the design: an inconspicuous local defect need not determine the whole criterion, while a tiny defining eye or junction can. Incidental texture differences alone should not lower a grade.

| Grade | Anchor |
| --- | --- |
| 0 — broken | A defining feature is absent, physically incoherent or plainly wrong. |
| 1 — needs rebuilding | The subject is recognizable, but a visible difference changes its shape, expression, color flow or depth. |
| 2 — close | The design reads faithfully; remaining differences are minor and localized. |
| 3 — convincing match | Defining structure and appearance survive at intended size; enlarged inspection shows clean contours and transitions. Pixel-exact texture is not required. |

| Criterion | Compare in the reference and render | Typical reason to score 0–1 | First repair to try |
| --- | --- | --- | --- |
| Composition, silhouette and proportions | Occupied area, pose, extrema, relative sizes, negative spaces and smooth versus irregular spans. | A changed pose, swollen contour, shifted landmark, or ripples and kinks along a quiet edge. | Overlay matched renders; refit the responsible contour span and its joins before shading. |
| Identity, anatomy and contact | Focal features and props, expression, visible limbs and digits, bends, gaps, and connections. | A generic face or prop, fused or misplaced fingers, malformed grip, disconnected part or ambiguous overlap. | Reconstruct the defining parts; follow each into its joint or contact and correct the occlusion order. |
| Color regions and palette | Position, area, sweep, inflection and taper of principal color regions; hue, saturation, brightness and relative contrast. | A curved region becomes a stripe, wedge or unrelated patch, or colors shift materially within correct boundaries. | Refit the boundary separately from its fill, then match the color progression. A linear gradient cannot bend its equal-color contours. |
| Volume, layering and edge character | Where light and dark begin and end, gradient direction and range, receiving surfaces for shadows, sharp and soft edges. | Flattened layers, reversed lighting, an outline replacing contact shadow, a halo or a misplaced highlight. | Match broad shading, then place local shadows beneath the casting contour and clip them to the receiving form. |
| Selective detail and visual rhythm | Distinctive secondary shapes, grouped repetition, spacing, contour variation and quieter areas. | Generic repeated symbols replace characteristic forms, or unnecessary marks compete with the focal region. | Restore the defining shapes and their variation; remove incidental noise. |

Support each low grade with a located difference. Before calling a surface flat, identify a missing or reversed transition, misplaced light/dark extremum or wrong sharp/soft edge. Inspect the exposed surface after clipping and overlaps. A clean vector appearance or nearly constant fill is faithful when the reference has that treatment; stronger gradients are not inherently better.

Repeated flattening or generic substitutes that materially alter an important region warrant a 1, even if the result is attractive. Grade against the reference, not against the previous attempt. Do not average away a misconnected part or misplaced main color region. Record a defect under its primary criterion, and note a separate consequence only when it affects another criterion.

## Choose and verify a repair

Fix 0–1 errors in defining features, anatomy, silhouette and major color regions before polishing secondary detail. A defining motif keeps this priority even when assessed under selective detail. Among remaining differences, choose those most noticeable or most important to the form's depth.

Work on one or two concrete changes per pass, preserving a render of the last good state. Compare the reference, previous render and revision at matching scale. Check the repaired feature, its adjoining curves and the full composition: better fingers or hair do not compensate for a newly rippled arm or torso. Restore a regressed span and narrow the edit rather than increasing detail everywhere. If reviewers disagree, inspect the cited difference before editing.

Use the rubric while establishing structure, after broad color and a representative shaded region, and at completion. Early review should test whether the construction method preserves the design before it is repeated throughout the artwork. Recheck earlier criteria when later layers change what is visible.

Keep review notes brief. During iteration, record the blocking or changed criteria; grade all five at completion. A useful format is:

`region | criterion and grade | reference fact | visible SVG difference | next edit`

For example: `main colored band | color regions 1 | boundary curves and narrows toward its tip | SVG uses a straight constant-width stripe | refit the boundary, then tune its fill`.

Measurements can help locate a problem, but whole-image similarity, byte counts and silhouette masks do not establish fidelity. Compare colors on both sides of a boundary and along its length. Follow the same physical or color-region boundary throughout; the strongest nearby pixel edge may jump to another shape. If fitted colors come from a neighboring surface, correct the boundary and visible mask before adjusting the gradient.

## Decide whether the asset is ready

For an ordinary deliverable, every criterion must reach at least 2, with no missing or materially changed defining feature. For a benchmark reconstruction, the first four criteria must reach 3 and selective detail at least 2; a defining motif under selective detail must also reach 3.

Name any remaining local compromise without treating a material loss as a passing result. Stop pursuing invisible texture differences. Independently apply the [SVG export and editability checks](../SKILL.md#svg-export-and-editability-checks); passing them does not raise a visual grade.
