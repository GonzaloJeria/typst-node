# @gjeria/html-to-typst

## 0.2.0

### Minor Changes

- b30542f: Fidelidad con Chrome, medida ahora con 13 plantillas (8 de Tailwind, una de 4 páginas): todas sobre 88 % y la mayoría sobre 97 %.

  - Tablas con ancho (`w-full`): las columnas `auto` se reparten el espacio en proporción a su contenido, como el layout automático de CSS. Los bordes colapsados entre filas ocupan su alto.
  - Los bordes cuentan en el tamaño de las cajas, como en CSS.
  - Los títulos (`h1`–`h6`) usan el tamaño y el peso del CSS. Antes Typst los agrandaba y ponía en negrita, aunque Tailwind los deje como texto normal.
  - CSS de Tailwind v4: degradados `in oklab`, `rounded-full` (`calc(infinity * 1px)`), `tabular-nums`, `indent-*`, `line-height` con `calc()` sin unidades, bordes `double` (aproximados con una línea).
  - `underline`/`line-through` en bloques.
  - `typst-pdf dev` rechaza otros nombres de host (DNS rebinding) y peticiones que no son JSON, y muestra el HTML sin ejecutar scripts. Google Fonts acepta solo archivos de `fonts.gstatic.com`, de hasta 10 MB.

  **Migración a 0.2.0:** sin `@page { margin }` la página ya no tiene el margen de Typst (~2,5 cm), sino ninguno, como `page.pdf()` de Puppeteer. Para mantener el aspecto anterior agrega `@page { margin: 25mm }`. Los títulos sin tamaño en el CSS ya no se agrandan. El README trae una guía para migrar desde Puppeteer o Playwright.

- 1121281: Más fidelidad con Chrome en plantillas Tailwind:

  - **Cambio de comportamiento:** sin `@page { margin }` la página no tiene margen, como `page.pdf()` de Puppeteer y Playwright. Si el CSS declara cajas de margen (`@top-center`, `@bottom-center`…) o las secciones traen `header`/`footer`, se mantiene un margen por defecto.
  - `vh`/`vw` se miden contra el área de la página (dentro de los márgenes), como Chrome al imprimir.
  - `min-height` da a la caja un alto definido cuando el contenido cabe: `justify-content` en columnas flex (`justify-between`, `center`, `end`…) y los hijos `absolute` con `bottom-0` funcionan dentro de ella.
  - Los hijos `position: absolute` de un contenedor flex/grid no cuentan como ítems, y se ubican contra el borde interior del padding, como en CSS.
  - Tablas con ancho propio (`w-48`, `width="600"`), filas con altura (`h-10` en `<tr>`) y celdas con padding distinto entre sí.
  - `white-space: nowrap`, el subrayado de `underline` sobre el `text-decoration: inherit` de Tailwind, y sin warnings por `vertical-align` en imágenes de bloque ni por `text-overflow`.

### Patch Changes

- c801883: Nuevo paquete `@gjeria/pdf-templates`: templates Handlebars + Tailwind desde archivos o una base de datos, con helpers en español (dinero, fechas, números), Google Fonts, limpieza del HTML hecho para el navegador (`<script>`, `<link>`), encabezado y pie con variables, y la CLI `typst-pdf` (`new`, `dev` con vista previa en vivo, `render`, `check`).

  Correcciones en `html-to-typst`:

  - Los documentos por secciones o con una página con nombre al inicio ya no empiezan con una página en blanco.
  - Los márgenes de cajas con `min-height`, imagen de fondo o sombra ya no se pierden.
  - Los bordes de `<tr>` se dibujan.

## 0.1.3

### Patch Changes

- a88a5cc: Per-corner `border-radius`, `overflow: hidden` clipping, `object-fit` on images (stretching by default, as in CSS) and `@font-face` fonts (TTF/OTF, loaded like images, with the CSS family mapped to the name inside the font file).

## 0.1.2

### Patch Changes

- 233bd08: Modern CSS and browser-like layout. Compiled Tailwind v4 and Bootstrap 5 stylesheets now apply: cascade layers, media queries evaluated against the page size, `@supports`, `@property`, CSS nesting, Selectors Level 4 (`:is`, `:where`, `:not`, `:has`, sibling combinators, `An+B of S`, escaped class names), `oklch()`/`lab()`/`color-mix()` and other CSS Color 4/5 functions, `min()`/`max()`/`clamp()`, viewport units, logical properties, the `font` shorthand and content-box widths. Layout now follows CSS more closely: line boxes from `line-height` (half-leading above and below), block spacing from margins only (with browser defaults for headings, paragraphs and lists, collapsing negative margins), hanging list markers, `flex-wrap`, flex columns with `align-items`, and `calc()` mixing `%` with lengths. Headings take their size and weight from CSS. `pnpm test:chrome` compares the output with Chrome.

## 0.1.1

### Patch Changes

- 0ac8626: Support `justify-content` and `align-items` on flex rows, shrink flex items with a background to their content, and apply `text-align` to headings (it was ignored, also when inherited or combined with a margin). `justify-content`/`align-items` on grids and column flex boxes now warn.
- df17d30: Fix silent layout bugs: table borders are now per cell (a table's own border no longer reaches its cells, and a header cell's border stays on that cell); inline `<svg>` renders as an image; `position: fixed` is offset from the page area inside the margins and spans `left`…`right`; `@page size: A6` and JIS sizes work. New warnings for margin boxes with a zero margin, unknown `@page` sizes or margins, and elements a PDF cannot show (video, canvas, form controls…). `<form>` content is no longer dropped.

## 0.1.0

### Minor Changes

- 69f2e0f: `height`, `min-height` and CSS background images (`url()` with `background-size`, `background-position`, `no-repeat`).
- 277f7a7: CSS multi-column layout (`column-count`, `columns`, `column-gap`) with balanced columns, and `@page` background images.
- 3b57733: Named pages (`page:` and `@page name`), `@page :first`, `counter(page)` in generated content, and a `layout` + `sections` composition API (`composeToTypst`, `render({ layout, sections })`).
