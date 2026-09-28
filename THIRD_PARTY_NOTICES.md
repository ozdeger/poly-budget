# Third-party notices

Poly Budget's own code is under the [MIT License](LICENSE). These parts come from others and keep their own terms.

## Instant Meshes (`src/quad.js`)

The quad remesher follows Instant Meshes (Wenzel Jakob, Marco Tarini, Daniele Panozzo and Olga Sorkine-Hornung, *Instant Field-Aligned Meshes*, ACM Transactions on Graphics 34(6), 2015), whose implementation carries this licence:

```
Copyright (c) 2015 Wenzel Jakob, Daniele Panozzo, Marco Tarini, and Olga Sorkine-Hornung. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
   following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
   following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote
   products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Libraries loaded when the page opens

[three.js](https://github.com/mrdoob/three.js) with its loaders, exporter and fflate, [meshoptimizer](https://github.com/zeux/meshoptimizer) and [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) load from jsDelivr and are not part of this repository. All of them are MIT licensed. The page's type is [IBM Plex](https://github.com/IBM/plex), under the SIL Open Font License, loaded from Google Fonts.

## Pictures

The pictures of models are not covered by the MIT License. They show these models, reduced or remeshed by Poly Budget:

| Pictures | Model | Licence |
| --- | --- | --- |
| `social-preview.jpg` | [Plaster cast of the Artemision Bronze (Poseidon or Zeus), KAS2100](https://commons.wikimedia.org/wiki/File:Poseidon_eller_Zeus_fra_Artemision_-_KAS2100.stl), Statens Museum for Kunst | CC0 1.0 |
| `docs/images/` | [Princess from Akhenaton's family](https://sketchfab.com/3d-models/princess-from-akhenatons-family-5dadcff13f87484a850e6ed027b90452), Benoit Rogez (shadows44), via [Real World Textured Things](http://texturedmesh.isti.cnr.it/) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `docs/examples/artec-bearded-guy.jpg`, `docs/examples/artec-lion.jpg` | Bearded guy HD and Lion statue, Artec 3D | CC BY 3.0 |
| `docs/examples/stanford-happy-buddha.jpg` | Happy Buddha, [Stanford 3D Scanning Repository](https://graphics.stanford.edu/data/3Dscanrep/), Stanford Computer Graphics Laboratory | Stanford's terms: free for research with credit, no commercial use without permission |

The test models in `test/models/manifest.json` are downloaded on demand and are not part of the repository; each entry lists its own source and licence.
