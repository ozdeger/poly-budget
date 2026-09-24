# Poly Budget

A browser tool that brings heavy 3D models down to a triangle budget without losing their look.

**Open it:** https://ozdeger.github.io/poly-budget/

- Open an FBX, GLB/GLTF, OBJ, STL or PLY with its textures. Everything runs in your browser; nothing is uploaded.
- Set a triangle budget and compare the original and the reduced model side by side.
- Work on several models at once in tabs: each tab keeps its own model, paint, mirror plane, budget and view.
- Paint areas that need more or less detail, or that must stay exactly as they are, with the floating tool palette on the view.
- Mirror symmetry: one half is reduced and mirrored, so every vertex has an exact partner.
- Texture mapping: the original UVs are kept while they still fit the texture. At low budgets the reduced model gets new UVs and its textures (base colour, normal, roughness and so on) are baked onto them from the original, in the background.
- Export a zip with FBX, GLB or OBJ and the textures.
- Your open tabs, with their textures, paint and view, reopen on your next visit. They are kept in your browser only.

## Build

`node build.js` builds `src/` into the single-file `index.html` that GitHub Pages serves.

- `src/core.js`: the mesh work (welding, meshoptimizer passes, UV fit check, unwrapping, FBX and OBJ writers). It has no DOM code, so it runs in Node too.
- `src/app.js`: the UI, loading, painting, the GPU texture bake, saving the last session and export.
- `src/worker.js`: reductions and unwraps, off the main thread.
- `src/index.html`: markup and styles.

Libraries, loaded from jsDelivr: three.js, meshoptimizer and three-mesh-bvh.

## Develop

- `npm install` installs the packages the tests use.
- `npm run serve` previews the built page at http://127.0.0.1:8731.
- `npm test` runs the tests on generated shapes: welding, painted reduction, the FBX and OBJ writers, symmetry and new UVs.
- To also run a test on a real model, pass its path: `node test/test_unwrap.js path/to/model.fbx`. The same works for test_core.js and test_symmetry.js.
- `testdata/` and `local/` are ignored by git, for your own models and helper scripts.
