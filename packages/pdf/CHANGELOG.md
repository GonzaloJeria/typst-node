# @gjeria/typst-html-pdf

## 0.1.0

### Minor Changes

- 69f2e0f: `height`, `min-height` and CSS background images (`url()` with `background-size`, `background-position`, `no-repeat`).
- 277f7a7: CSS multi-column layout (`column-count`, `columns`, `column-gap`) with balanced columns, and `@page` background images.
- 3b57733: Named pages (`page:` and `@page name`), `@page :first`, `counter(page)` in generated content, and a `layout` + `sections` composition API (`composeToTypst`, `render({ layout, sections })`).
- 27fe5c0: `SidecarBackend`: keeps `typst-sidecar` processes (an in-house Rust binary over the official Typst crates) running between documents. `PdfRenderer` accepts `sidecar` options and `warmup()`.

### Patch Changes

- Updated dependencies [69f2e0f]
- Updated dependencies [277f7a7]
- Updated dependencies [3b57733]
- Updated dependencies [27fe5c0]
  - @gjeria/html-to-typst@0.1.0
  - @gjeria/typst-compiler@0.1.0
