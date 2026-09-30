---
"@gjeria/typst-html-pdf": minor
"@gjeria/html-to-typst": minor
"@gjeria/typst-compiler": patch
---

Bundle Inter as the default `sans-serif`/`system-ui` font (`bundledFontsDir`, `bundledFonts` option), and build the static Linux `typst-sidecar` with jemalloc: ~30% less memory and faster than mimalloc.
