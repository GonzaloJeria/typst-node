---
"@gjeria/html-to-typst": patch
"@gjeria/typst-html-pdf": patch
"@gjeria/pdf-templates": patch
---

Mejoras reportadas al migrar una liquidación:

- Encabezado y pie: ocupan todo el ancho y respetan la alineación del HTML (`text-left`, `text-right`, `mr-auto`); siguen centrados por defecto.
- Un encabezado o pie más alto que su margen agranda ese margen lo necesario, en vez de montarse sobre el contenido.
- `position: fixed` dentro del encabezado o pie se ubica sobre la hoja completa, y `top` + `bottom` le dan alto (`fixed inset-[4mm] border` dibuja un marco en cada hoja).
- `@page { border; padding }` y `page.border` / `page.padding`: marco alrededor del contenido en cada página.
- `vertical-align` (`top`, `middle`, `bottom`) y el atributo `valign` en celdas de tabla.
- Transpilación ~50 % más rápida en documentos con Tailwind: los `::before`/`::after` sin `content` ya no se calculan por elemento, y las validaciones de declaraciones repetidas se memorizan.
