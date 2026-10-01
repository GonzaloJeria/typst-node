---
"@gjeria/typst-html-pdf": minor
"@gjeria/pdf-templates": minor
---

Tailwind CSS v4 incluido (el paquete `tailwindcss`, JavaScript puro, sin binarios nativos):

- `render(html, { tailwind: true })` en `@gjeria/typst-html-pdf` genera el CSS de las clases usadas; los `<style>` y la opción `css` pueden usar `@theme`, `@apply` y `@utility`. También funciona con secciones, header y footer. Se exporta `tailwindCss(html, css)`.
- `@gjeria/pdf-templates` usa Tailwind por defecto y ya no necesita instalar `tailwindcss` ni `@tailwindcss/node`; `tailwind: false` para templates de CSS puro.
- Avisos para clases desconocidas, breakpoints más anchos que la página (`lg:` en A4) y estados que no existen en papel (`hover:`, `dark:`).
- `font-sans`, `font-serif` y `font-mono` usan las fuentes del PDF, sin advertencias por fuentes de escritorio ausentes.
