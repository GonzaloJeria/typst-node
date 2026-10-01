# @gjeria/pdf-templates

PDFs a partir de templates: HTML con Handlebars y Tailwind, desde archivos o desde
tu base de datos, renderizados con Typst (sin Chromium). Incluye una CLI con
vista previa en vivo.

```sh
npm i @gjeria/pdf-templates tailwindcss @tailwindcss/node
```

`tailwindcss` y `@tailwindcss/node` solo hacen falta si usas Tailwind.

## En 1 minuto

```sh
npx typst-pdf new factura     # crea templates/factura con un ejemplo
npx typst-pdf dev             # abre la vista previa en http://127.0.0.1:3333
```

```ts
import { createTemplates } from "@gjeria/pdf-templates";

const templates = createTemplates({ source: "./templates" });
await templates.warmup();

const { pdf, warnings } = await templates.render("factura", { numero: "F-0001", cliente, items });
```

## Qué hace por ti

- **Handlebars** con escape automático de los datos, partials y helpers para
  dinero, fechas y números en español de Chile (configurables).
- **Tailwind sin configurar nada**: genera el CSS de las clases que usa el
  template, con tu `@theme`, `@apply` y `@layer`. El
  `<script src="https://cdn.tailwindcss.com">` de un HTML hecho para el
  navegador se detecta y se reemplaza solo.
- **Google Fonts**: un `<link href="https://fonts.googleapis.com/css2?family=Roboto…">`
  descarga la fuente en TTF y la usa.
- **HTML del navegador tal cual**: los `<script>` se quitan (con aviso), los
  `<link rel="stylesheet">` locales se incrustan y las imágenes relativas se
  resuelven contra la carpeta del template.
- **Encabezado y pie de página** con número de página, también con variables
  (`{{cliente.nombre}} · {{page}}/{{pages}}`).

## Templates desde la base de datos

Un template es un objeto. Guárdalo como quieras (una fila, un documento) y
entrégalo con `source`:

```ts
import { createTemplates } from "@gjeria/pdf-templates";

const templates = createTemplates({
  // Se llama en cada render: lee la versión actual de la base de datos.
  source: async (nombre) => {
    const row = await db.plantillas.findOne({ nombre });
    return row && { html: row.html, css: row.css, page: row.page, tailwind: true };
  },
});

const { pdf } = await templates.render("orden-de-compra", datos);
```

Si ya tienes el template cargado, pásalo directamente:

```ts
const { pdf } = await templates.render({ html: row.html, css: row.css, tailwind: true }, datos);
```

El Handlebars compilado y el compilador de Tailwind se guardan en caché según
el contenido del template. Leer el template en cada request es barato, y
cuando cambia en la base de datos se usa la versión nueva sin reiniciar.

| Campo | Qué es |
|---|---|
| `html` | HTML con `{{variables}}`: un documento completo o un fragmento |
| `css` | CSS del template (con Tailwind puede usar `@theme`, `@apply`…) |
| `page` | `{ size, margin, background, header, footer }`, ver abajo |
| `partials` | `{ nombre: "<html>" }` para `{{> nombre}}` |
| `sample` | datos de ejemplo, para la vista previa y `check` |
| `tailwind` | `true`, `false` o `"auto"` (por defecto: si el template carga Tailwind o usa `@theme`/`@apply`) |
| `baseDir` | carpeta para imágenes, fuentes y hojas de estilo relativas |

Para ver y probar templates de la base de datos con la CLI, crea un módulo que
exporte la fuente:

```js
// plantillas.mjs
import { db } from "./db.mjs";
export default {
  get: async (nombre) => db.plantillas.findOne({ nombre }),
  list: async () => (await db.plantillas.find()).map((p) => p.nombre),
};
```

```sh
npx typst-pdf dev --source plantillas.mjs
npx typst-pdf check --source plantillas.mjs
```

## Templates en archivos

```
templates/
  _partials/firma.html        partials compartidos: {{> firma}}
  factura/
    template.html             (o index.html)
    style.css                 opcional
    data.json                 datos de ejemplo (vista previa y check)
    template.json             opcional: { "tailwind": true, "page": { … } }
    partials/linea.html       partials solo de este template
    logo.png                  imágenes y fuentes, relativas a la carpeta
  informes/mensual/…          se pueden anidar: templates.render("informes/mensual", …)
```

Los archivos se leen en cada render, así que los cambios se ven sin reiniciar.

## Página, encabezado y pie

```json
{
  "page": {
    "size": "A4",
    "margin": "15mm 15mm 20mm",
    "header": "<img src='logo.png' style='height: 10mm'>",
    "footer": "<div style='text-align: right; font-size: 8pt'>{{empresa.nombre}} · Página {{page}} de {{pages}}</div>"
  }
}
```

Lo mismo se puede hacer con CSS: `@page { size: A4; margin: 15mm }`. Sin
`@page { margin }` ni `page`, la página no tiene margen, como en el
`page.pdf()` de Puppeteer. En ese caso el diseño lo controla el padding del
HTML.

## Helpers

| Helper | Ejemplo | Resultado |
|---|---|---|
| `money` | `{{money total}}` · `{{money total "USD"}}` | `$1.234.567` · `US$10,50` |
| `number` | `{{number 1234.5}}` · `{{number x 2}}` | `1.234,5` · `3,00` |
| `percent` | `{{percent 0.1896}}` | `18,96 %` |
| `date` | `{{date fecha "dd/MM/yyyy"}}` · `{{date fecha "d 'de' MMMM 'de' yyyy"}}` · `{{date fecha "long"}}` | `05/03/2026` · `5 de marzo de 2026` |
| `upper` `lower` `capitalize` | `{{upper nombre}}` | |
| `default` | `{{default telefono "—"}}` | |
| `join` | `{{join etiquetas ", "}}` | |
| `eq` `ne` `gt` `gte` `lt` `lte` `and` `or` `not` | `{{#if (gt total 0)}}…{{/if}}` | |
| `add` `sub` `mul` `div` `round` | `{{money (mul cantidad precio)}}` | |
| `sum` | `{{money (sum items "total")}}` | suma un campo de una lista |
| `inc` | `{{inc @index}}` | numeración desde 1 |

`{{valor}}` escapa el HTML; `{{{valor}}}` lo inserta sin escapar (solo para HTML
en el que confías). Formato y zona horaria se configuran con
`createTemplates({ locale: "es-CL", currency: "CLP", timeZone: "America/Santiago" })`.
Para agregar tus propios helpers usa `helpers: { iva: (n) => n * 0.19 }`.

## Opciones

```ts
createTemplates({
  source: "./templates",            // carpeta, función (nombre) => template, o { get, list }
  tailwind: "auto",                 // true | false | "auto"
  googleFonts: true,                // descargar fuentes de <link> a Google Fonts
  helpers: {},                      // helpers propios
  partials: {},                     // partials para todos los templates
  strictData: false,                // true: error si falta una variable en los datos
  locale: "es-CL", currency: "CLP", timeZone: undefined,
  renderer,                         // un PdfRenderer existente, o:
  rendererOptions: {                // opciones del renderer (ver @gjeria/typst-html-pdf)
    sidecar: { processes: 2, timeoutMs: 15_000 },
    defaults: { assets: { allowRemote: true, allowedHosts: ["cdn.miempresa.com"] } },
  },
});
```

| Método | Devuelve |
|---|---|
| `render(nombreOTemplate, datos?, opciones?)` | `{ pdf, warnings, diagnostics, html, css, source }` |
| `renderPages(nombreOTemplate, datos?, { format, ppi })` | una imagen PNG/SVG por página (miniaturas) |
| `html(nombreOTemplate, datos?)` | el HTML y CSS finales, sin generar el PDF |
| `list()` | nombres de los templates de la fuente |
| `warmup()` / `dispose()` | arrancar y cerrar los procesos de Typst |

Sin `datos`, se usan los datos de ejemplo del template (`sample` o `data.json`).

## CLI

```
typst-pdf new <nombre> [--plain]     crea templates/<nombre> (Tailwind; --plain: CSS simple)
typst-pdf dev [--port 3333]          vista previa en vivo
typst-pdf render <nombre> [--data datos.json] [--out archivo.pdf]
typst-pdf check [--strict]           renderiza todo con data.json y lista los warnings (útil en CI)

--dir <carpeta>     carpeta de templates (por defecto ./templates)
--source <módulo>   fuente de templates propia (base de datos, API…)
```

**La vista previa** muestra el PDF real junto al mismo HTML en el navegador,
la lista de warnings y los datos como JSON editable. Al cambiar un archivo o
editar los datos, se vuelve a renderizar. El navegador muestra la versión de
pantalla, así que las reglas `@media print` solo se ven en el PDF.

## Buenas prácticas

- **Diseña mirando la vista previa** (`typst-pdf dev`), no el navegador: el PDF
  es lo que verá tu usuario.
- **Calcula en los datos, presenta en el template.** Totales, impuestos y
  textos condicionales complejos quedan más claros en tu código. El template
  solo los formatea.
- **Una hoja A4 mide ~794 px de ancho**: las clases `sm:` y `md:` aplican,
  `lg:` y `xl:` no.
- **Corre `typst-pdf check --strict` en CI** para detectar CSS no soportado
  antes de desplegar.
- **Usa `allowedHosts`** si los templates cargan imágenes remotas.
