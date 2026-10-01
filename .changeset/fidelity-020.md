---
"@gjeria/html-to-typst": minor
"@gjeria/typst-html-pdf": minor
"@gjeria/pdf-templates": minor
---

Fidelidad con Chrome, medida ahora con 13 plantillas (8 de Tailwind, una de 4 páginas): todas sobre 88 % y la mayoría sobre 97 %.

- Tablas con ancho (`w-full`): las columnas `auto` se reparten el espacio en proporción a su contenido, como el layout automático de CSS. Los bordes colapsados entre filas ocupan su alto.
- Los bordes cuentan en el tamaño de las cajas, como en CSS.
- Los títulos (`h1`–`h6`) usan el tamaño y el peso del CSS. Antes Typst los agrandaba y ponía en negrita, aunque Tailwind los deje como texto normal.
- CSS de Tailwind v4: degradados `in oklab`, `rounded-full` (`calc(infinity * 1px)`), `tabular-nums`, `indent-*`, `line-height` con `calc()` sin unidades, bordes `double` (aproximados con una línea).
- `underline`/`line-through` en bloques.
- `typst-pdf dev` rechaza otros nombres de host (DNS rebinding) y peticiones que no son JSON, y muestra el HTML sin ejecutar scripts. Google Fonts acepta solo archivos de `fonts.gstatic.com`, de hasta 10 MB.

**Migración a 0.2.0:** sin `@page { margin }` la página ya no tiene el margen de Typst (~2,5 cm), sino ninguno, como `page.pdf()` de Puppeteer. Para mantener el aspecto anterior agrega `@page { margin: 25mm }`. Los títulos sin tamaño en el CSS ya no se agrandan. El README trae una guía para migrar desde Puppeteer o Playwright.
