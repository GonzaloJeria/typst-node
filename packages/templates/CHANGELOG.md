# @gjeria/pdf-templates

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

- c801883: Nuevo paquete `@gjeria/pdf-templates`: templates Handlebars + Tailwind desde archivos o una base de datos, con helpers en español (dinero, fechas, números), Google Fonts, limpieza del HTML hecho para el navegador (`<script>`, `<link>`), encabezado y pie con variables, y la CLI `typst-pdf` (`new`, `dev` con vista previa en vivo, `render`, `check`).

  Correcciones en `html-to-typst`:

  - Los documentos por secciones o con una página con nombre al inicio ya no empiezan con una página en blanco.
  - Los márgenes de cajas con `min-height`, imagen de fondo o sombra ya no se pierden.
  - Los bordes de `<tr>` se dibujan.

- dc5006b: Tailwind CSS v4 incluido (el paquete `tailwindcss`, JavaScript puro, sin binarios nativos):

  - `render(html, { tailwind: true })` en `@gjeria/typst-html-pdf` genera el CSS de las clases usadas; los `<style>` y la opción `css` pueden usar `@theme`, `@apply` y `@utility`. También funciona con secciones, header y footer. Se exporta `tailwindCss(html, css)`.
  - `@gjeria/pdf-templates` usa Tailwind por defecto y ya no necesita instalar `tailwindcss` ni `@tailwindcss/node`; `tailwind: false` para templates de CSS puro.
  - Avisos para clases desconocidas, breakpoints más anchos que la página (`lg:` en A4) y estados que no existen en papel (`hover:`, `dark:`).
  - `font-sans`, `font-serif` y `font-mono` usan las fuentes del PDF, sin advertencias por fuentes de escritorio ausentes.

### Patch Changes

- Updated dependencies [b30542f]
- Updated dependencies [1121281]
- Updated dependencies [dc5006b]
  - @gjeria/typst-html-pdf@0.2.0
