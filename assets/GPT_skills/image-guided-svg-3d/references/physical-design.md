# Physical design

Let measured requirements control the geometry and references guide its appearance. Preserve the user's chosen tool or existing project; otherwise, prefer parametric CAD such as CadQuery for functional parts. Sculpted objects can keep their mesh workflow and use the relevant export and fabrication checks below.

## Establish requirements

Resolve units, overall size, critical interfaces and fabrication process. Ask for missing dimensions that determine fit; choose and disclose provisional values for unconstrained styling.

Use dimensioned drawings and measurements from calibrated references within their stated accuracy. Unscaled photos and generated concepts cannot establish fit dimensions, hidden geometry, tolerances or mechanical feasibility. Never treat generated dimension labels as measurements.

Build directly when dimensions already define the part. When appearance needs exploration, use the [reference workflow](../SKILL.md#develop-a-useful-reference) to develop a constructible concept with clear component boundaries, accessible openings and plausible connections. Additional views can clarify the idea but do not prove geometric consistency.

## Build parametric geometry

Expose important dimensions as named parameters and derive dependent geometry from them and stable datums. Select features by geometric intent, checking the expected selection count, rather than relying on incidental face or edge indices. State valid parameter ranges and reject combinations that erase required walls or create unintended intersections.

Build the functional shape and design-critical transitions first, inspecting sections and minimum thickness through fillets, lofts or sweeps. Add cosmetic edge treatments after the shape is stable. Openings, walls and joints need real geometry; a rendered seam or texture is not a physical feature.

Keep mating parts separate and define their placement and intended clearance. Specify whether an allowance is per side, radial or total, based on mating measurements and the fabrication process. Fit allowances change the geometry; kernel and mesh-export tolerances control computation and approximation. They do not compensate for printer error.

If CAD execution is unavailable, retain the requested workflow and explain the missing dependency rather than silently substituting a mesh. A mesh render can preview CAD geometry without replacing its editable source.

## Validate geometry and exports

Rebuild the saved source and test a representative dimension change. Recheck dependent geometry, then restore and verify the requested model. Open the actual exports and check:

- Overall dimensions, critical openings, hole positions, wall and floor thicknesses against requirements. A matching bounding box alone does not establish fit.
- Nonempty valid solids, positive volume, expected solid/component counts and unintended intersections. For assemblies, check clearances and relevant positions of moving or inserted parts.
- Mesh exports that preserve critical curves and small features. For CAD-to-mesh tessellation, choose an explicit absolute or relative tolerance. Check all exported meshes for watertightness, non-manifold edges, disconnected fragments and import scale.

For CadQuery, call the installed `Shape.exportStl` API directly when you need explicit `relative=False`; do not assume `exporters.export(..., opt=...)` forwards that setting. Check the installed signature and exported result.

Compare useful rendered views with the concept when one is used. Repair failing interfaces or walls before cosmetic detail, then recheck affected dimensions and exports. Visual similarity must not override a specified dimension or clearance.

## Check fabrication

Apply the relevant geometry and export checks above to both CAD and mesh models. Check the machine envelope, thin features, overhangs, support access and orientation for the chosen process. Use process-specific clearances and thicknesses; consider a small fit-test piece for an interface whose allowance remains unverified.

When a slicer is available, inspect layers at critical walls, openings and connections. Keep geometry validation, slicer validation and physical print or fit testing distinct; a good render proves none of them.

## Deliver

Provide the editable CAD source or native project, a solid exchange format such as STEP when supported, and the requested fabrication export plus a preview. STEP preserves solid geometry, not the parameterized source or feature history. State units, important assumptions and completed checks; for STL, verify the receiving application's scale when possible. Distinguish assumed dimensions and untested fit from a model verified against supplied requirements.
