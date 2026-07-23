# Third-Party Notices

Earthy is distributed under the PolyForm Noncommercial License 1.0.0 (see
[LICENSE](./LICENSE)). That license covers **only Earthy's own source code**.
Earthy also incorporates the third-party components listed below, each of which
remains licensed under its **own** terms — those terms are not changed by
Earthy's license, and your rights in those components come from their licenses,
not from Earthy's.

Versions listed are those bundled at the time of writing; regenerate this file
when dependencies change. Full license texts for the bundled packages are also
present in their respective `node_modules/<package>/` directories, and packaged
builds should include an aggregated license file (e.g. one produced by
electron-builder).

---

## Bundled at runtime (shipped in Earthy)

| Component | Version | License | Project |
|---|---|---|---|
| CesiumJS | 1.143.0 | Apache-2.0 | https://cesium.com/cesiumjs/ · https://github.com/CesiumGS/cesium |
| gdal3.js (GDAL/PROJ/GEOS via WebAssembly) | 2.8.1 | LGPL-2.1-or-later | https://gdal3.js.org · https://github.com/bugra9/gdal3.js |
| Electron (bundles Chromium, Node.js, V8) | 33.4.11 | MIT (+ bundled third-party licenses) | https://www.electronjs.org · https://github.com/electron/electron |
| React | 18.3.1 | MIT | https://react.dev · https://github.com/facebook/react |
| React DOM | 18.3.1 | MIT | https://react.dev · https://github.com/facebook/react |
| react-arborist | 3.13.2 | MIT | https://github.com/brimdata/react-arborist |
| Zustand | 5.0.14 | MIT | https://github.com/pmndrs/zustand |
| @xmldom/xmldom | 0.9.10 | MIT | https://github.com/xmldom/xmldom |
| electron-store | 8.2.0 | MIT | https://github.com/sindresorhus/electron-store |
| JSZip | 3.10.1 | MIT (dual: MIT OR GPL-3.0-or-later — MIT elected) | https://stuk.github.io/jszip/ · https://github.com/Stuk/jszip |
| DOMPurify (via CesiumJS) | 3.4.11 | Apache-2.0 (dual: MPL-2.0 OR Apache-2.0 — Apache-2.0 elected) | https://github.com/cure53/DOMPurify |

Build-time only tools (Vite, electron-vite, Vitest, TypeScript, ESLint,
electron-builder, etc.) are **not** distributed in the application and are not
listed here.

---

## Notices and obligations

### CesiumJS — Apache License 2.0

Copyright © CesiumGS, Inc. and Contributors.

Licensed under the Apache License, Version 2.0. You may obtain a copy at
<https://www.apache.org/licenses/LICENSE-2.0>. See Cesium's `LICENSE.md` and
`NOTICE` (reproduced in `node_modules/cesium/`) for the required attributions of
Cesium and its own third-party data/code.

### gdal3.js — LGPL-2.1-or-later

gdal3.js packages GDAL and its dependencies (including PROJ and GEOS) compiled to
WebAssembly.

- GDAL core: MIT/X11-style license — <https://gdal.org/en/stable/license.html>
- PROJ: MIT-style license — <https://proj.org>
- GEOS: **LGPL-2.1** — <https://libgeos.org> — this is the component that makes
  the combined build LGPL.

Because gdal3.js is LGPL-2.1-or-later, Earthy ships it as a **separate,
replaceable** WebAssembly/JS module (it is not statically merged into Earthy's
own code), and the
complete corresponding source is available from the gdal3.js project at
<https://github.com/bugra9/gdal3.js> (version 2.8.1). The LGPL-2.1 text is
available at <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>.

### Electron — MIT (with bundled third parties)

Copyright © Electron contributors; Copyright © 2013–2020 GitHub Inc.

Electron itself is MIT-licensed but redistributes Chromium, Node.js, V8, and
other components under their own licenses (BSD-3-Clause and others). The
aggregated license text is available from Electron (`LICENSES.chromium.html` in a
packaged build, or the app's "About" acknowledgements).

### MIT-licensed packages

The following are used under the MIT License: React, React DOM, react-arborist,
Zustand, @xmldom/xmldom, electron-store, and JSZip (MIT elected). The MIT License
permission notice below applies to each, with copyright held by the respective
authors:

- React, React DOM — Copyright © Meta Platforms, Inc. and affiliates
- react-arborist — Copyright © James Kerr / Brim contributors
- Zustand — Copyright © Paul Henschel and the pmndrs collective
- @xmldom/xmldom — Copyright © the xmldom authors
- electron-store — Copyright © Sindre Sorhus
- JSZip — Copyright © Stuart Knightley and contributors

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### DOMPurify — Apache-2.0 (elected)

Copyright © Cure53 and other contributors. Used under the Apache License 2.0
option of its `MPL-2.0 OR Apache-2.0` dual license. See
<https://www.apache.org/licenses/LICENSE-2.0>.

---

*This is a good-faith starter notice, not legal advice. If you distribute Earthy
widely or otherwise rely on its licensing, have a professional review it — in
particular the LGPL obligations around the gdal3.js WebAssembly module.*
