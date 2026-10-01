# @gjeria/typst-html-pdf

## 0.1.3

### Patch Changes

- a88a5cc: Per-corner `border-radius`, `overflow: hidden` clipping, `object-fit` on images (stretching by default, as in CSS) and `@font-face` fonts (TTF/OTF, loaded like images, with the CSS family mapped to the name inside the font file).
- Updated dependencies [a88a5cc]
  - @gjeria/html-to-typst@0.1.3
  - @gjeria/typst-compiler@0.1.3

## 0.1.2

### Patch Changes

- 233bd08: Modern CSS and browser-like layout. Compiled Tailwind v4 and Bootstrap 5 stylesheets now apply: cascade layers, media queries evaluated against the page size, `@supports`, `@property`, CSS nesting, Selectors Level 4 (`:is`, `:where`, `:not`, `:has`, sibling combinators, `An+B of S`, escaped class names), `oklch()`/`lab()`/`color-mix()` and other CSS Color 4/5 functions, `min()`/`max()`/`clamp()`, viewport units, logical properties, the `font` shorthand and content-box widths. Layout now follows CSS more closely: line boxes from `line-height` (half-leading above and below), block spacing from margins only (with browser defaults for headings, paragraphs and lists, collapsing negative margins), hanging list markers, `flex-wrap`, flex columns with `align-items`, and `calc()` mixing `%` with lengths. Headings take their size and weight from CSS. `pnpm test:chrome` compares the output with Chrome.
- Updated dependencies [233bd08]
  - @gjeria/html-to-typst@0.1.2
  - @gjeria/typst-compiler@0.1.2

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
