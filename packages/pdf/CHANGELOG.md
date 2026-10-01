# @gjeria/typst-html-pdf

## 0.1.1

### Patch Changes

- 0ac8626: Support `justify-content` and `align-items` on flex rows, shrink flex items with a background to their content, and apply `text-align` to headings (it was ignored, also when inherited or combined with a margin). `justify-content`/`align-items` on grids and column flex boxes now warn.
- df17d30: Fix silent layout bugs: table borders are now per cell (a table's own border no longer reaches its cells, and a header cell's border stays on that cell); inline `<svg>` renders as an image; `position: fixed` is offset from the page area inside the margins and spans `left`…`right`; `@page size: A6` and JIS sizes work. New warnings for margin boxes with a zero margin, unknown `@page` sizes or margins, and elements a PDF cannot show (video, canvas, form controls…). `<form>` content is no longer dropped.
- Updated dependencies [0ac8626]
- Updated dependencies [df17d30]
  - @gjeria/html-to-typst@0.1.1
  - @gjeria/typst-compiler@0.1.1

## 0.1.0

### Minor Changes

- Bundle Inter as the default `sans-serif`/`system-ui` font (`bundledFontsDir`, `bundledFonts` option).
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
