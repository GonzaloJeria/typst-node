# @gjeria/typst-html-pdf

## 0.2.3

### Patch Changes

- cf134b0: Menos tiempo y menos memoria en microservicios:

  - Los elementos con la misma etiqueta, atributos y estilo de padre comparten su estilo calculado, como en los navegadores (filas y celdas de tabla). Una tabla de 300 filas con Tailwind convierte en ~60 ms en vez de ~140 ms (0.2.2) o ~300 ms (0.2.1). El resultado es idéntico byte a byte.
  - `sidecar.idleTimeoutMs` (60 s por defecto): los procesos de Typst sin trabajo se detienen y devuelven su memoria; el siguiente documento los arranca de nuevo en ~50 ms.
  - `transpileWorkers` (opcional, 0 por defecto): convierte el HTML en worker threads para no bloquear el event loop con documentos grandes.
  - `stats()` incluye `transpileWorkers`.

- Updated dependencies [cf134b0]
  - @gjeria/typst-compiler@0.2.3
  - @gjeria/html-to-typst@0.2.3

## 0.2.2

### Patch Changes

- 16adbb4: Mejoras reportadas al migrar una liquidación:

  - Encabezado y pie: ocupan todo el ancho y respetan la alineación del HTML (`text-left`, `text-right`, `mr-auto`); siguen centrados por defecto.
  - Un encabezado o pie más alto que su margen agranda ese margen lo necesario, en vez de montarse sobre el contenido.
  - `position: fixed` dentro del encabezado o pie se ubica sobre la hoja completa, y `top` + `bottom` le dan alto (`fixed inset-[4mm] border` dibuja un marco en cada hoja).
  - `@page { border; padding }` y `page.border` / `page.padding`: marco alrededor del contenido en cada página.
  - `vertical-align` (`top`, `middle`, `bottom`) y el atributo `valign` en celdas de tabla.
  - Transpilación ~50 % más rápida en documentos con Tailwind: los `::before`/`::after` sin `content` ya no se calculan por elemento, y las validaciones de declaraciones repetidas se memorizan.

- Updated dependencies [16adbb4]
  - @gjeria/html-to-typst@0.2.2
  - @gjeria/typst-compiler@0.2.2

## 0.2.1

### Patch Changes

- 35125ab: Documentación: Tailwind como forma recomendada de escribir templates (por qué, ejemplos y buenas prácticas para tablas largas y nombres de campos).
- 7585d4a: Para producción:

  - `maxQueue` en `SidecarBackend` y `CliBackend`: con la cola llena, `compile` rechaza al instante con `TypstQueueFullError` en vez de acumular documentos en memoria.
  - `stats()` en los backends, `PdfRenderer` y `PdfTemplates`: capacidad, procesos vivos, en curso, en cola y totales (completados, fallidos, rechazados), para health checks y métricas.
  - `timings` en cada resultado: `transpileMs`, `assetsMs`, `compileMs` y `totalMs`.
  - Helper `date`: un día del calendario (`"2026-10-02"`, o un `Date` a medianoche UTC como los que guarda una base de datos) ya no se corre al día anterior según la zona horaria.
  - Aviso cuando un template usa `{{number}}`, `{{date}}` u otro helper sin argumentos como si fuera un campo (no muestra nada).

- Updated dependencies [7585d4a]
  - @gjeria/typst-compiler@0.2.1
  - @gjeria/html-to-typst@0.2.1

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

- dc5006b: Tailwind CSS v4 incluido (el paquete `tailwindcss`, JavaScript puro, sin binarios nativos):

  - `render(html, { tailwind: true })` en `@gjeria/typst-html-pdf` genera el CSS de las clases usadas; los `<style>` y la opción `css` pueden usar `@theme`, `@apply` y `@utility`. También funciona con secciones, header y footer. Se exporta `tailwindCss(html, css)`.
  - `@gjeria/pdf-templates` usa Tailwind por defecto y ya no necesita instalar `tailwindcss` ni `@tailwindcss/node`; `tailwind: false` para templates de CSS puro.
  - Avisos para clases desconocidas, breakpoints más anchos que la página (`lg:` en A4) y estados que no existen en papel (`hover:`, `dark:`).
  - `font-sans`, `font-serif` y `font-mono` usan las fuentes del PDF, sin advertencias por fuentes de escritorio ausentes.

### Patch Changes

- Updated dependencies [b30542f]
- Updated dependencies [c801883]
- Updated dependencies [1121281]
  - @gjeria/html-to-typst@0.2.0
  - @gjeria/typst-compiler@0.2.0

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
