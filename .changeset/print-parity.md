---
"@gjeria/html-to-typst": minor
"@gjeria/typst-html-pdf": minor
---

Más fidelidad con Chrome en plantillas Tailwind:

- **Cambio de comportamiento:** sin `@page { margin }` la página no tiene margen, como `page.pdf()` de Puppeteer y Playwright. Si el CSS declara cajas de margen (`@top-center`, `@bottom-center`…) o las secciones traen `header`/`footer`, se mantiene un margen por defecto.
- `vh`/`vw` se miden contra el área de la página (dentro de los márgenes), como Chrome al imprimir.
- `min-height` da a la caja un alto definido cuando el contenido cabe: `justify-content` en columnas flex (`justify-between`, `center`, `end`…) y los hijos `absolute` con `bottom-0` funcionan dentro de ella.
- Los hijos `position: absolute` de un contenedor flex/grid no cuentan como ítems, y se ubican contra el borde interior del padding, como en CSS.
- Tablas con ancho propio (`w-48`, `width="600"`), filas con altura (`h-10` en `<tr>`) y celdas con padding distinto entre sí.
- `white-space: nowrap`, el subrayado de `underline` sobre el `text-decoration: inherit` de Tailwind, y sin warnings por `vertical-align` en imágenes de bloque ni por `text-overflow`.
