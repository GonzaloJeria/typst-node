---
"@gjeria/pdf-templates": minor
"@gjeria/html-to-typst": patch
---

Nuevo paquete `@gjeria/pdf-templates`: templates Handlebars + Tailwind desde archivos o una base de datos, con helpers en español (dinero, fechas, números), Google Fonts, limpieza del HTML hecho para el navegador (`<script>`, `<link>`), encabezado y pie con variables, y la CLI `typst-pdf` (`new`, `dev` con vista previa en vivo, `render`, `check`).

Correcciones en `html-to-typst`:
- Los documentos por secciones o con una página con nombre al inicio ya no empiezan con una página en blanco.
- Los márgenes de cajas con `min-height`, imagen de fondo o sombra ya no se pierden.
- Los bordes de `<tr>` se dibujan.
