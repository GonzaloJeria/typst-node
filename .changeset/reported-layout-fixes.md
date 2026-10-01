---
"@gjeria/html-to-typst": patch
"@gjeria/typst-html-pdf": patch
---

Fix silent layout bugs: table borders are now per cell (a table's own border no longer reaches its cells, and a header cell's border stays on that cell); inline `<svg>` renders as an image; `position: fixed` is offset from the page area inside the margins and spans `left`…`right`; `@page size: A6` and JIS sizes work. New warnings for margin boxes with a zero margin, unknown `@page` sizes or margins, and elements a PDF cannot show (video, canvas, form controls…). `<form>` content is no longer dropped.
