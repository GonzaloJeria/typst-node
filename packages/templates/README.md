# @gjeria/pdf-templates

PDFs a partir de templates: HTML con Handlebars y **Tailwind CSS**, desde
archivos o desde tu base de datos, renderizados con Typst (sin Chromium).
Incluye una CLI con vista previa en vivo.

```sh
npm i @gjeria/pdf-templates
```

Tailwind CSS v4 viene incluido y activado: no hay nada más que instalar ni
configurar.

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
- **Tailwind incluido y activado por defecto**: genera el CSS solo de las
  clases que usa el template, con tu `@theme`, `@apply` y `@utility`. Si el
  HTML trae el `<script src="https://cdn.tailwindcss.com">` (hecho para el
  navegador), simplemente se quita: el CSS ya está generado.
- **Avisos de Tailwind**: clases mal escritas (`txt-red-500`), breakpoints que
  no caben en la página (`lg:` en A4) y estados que no existen en papel
  (`hover:`, `dark:`).
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
    return row && { html: row.html, css: row.css, page: row.page };
  },
});

const { pdf } = await templates.render("orden-de-compra", datos);
```

Si ya tienes el template cargado, pásalo directamente:

```ts
const { pdf } = await templates.render({ html: row.html, css: row.css }, datos);
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
| `tailwind` | `true` (por defecto), `false` para templates de CSS puro, o `"auto"` |
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
    template.json             opcional: { "page": { … } } ("tailwind": false para CSS puro)
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
  tailwind: true,                   // false: templates de CSS puro, sin el reset de Tailwind
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

## Tailwind para PDFs

**Recomendamos escribir los templates con Tailwind** (viene activado):

- **El PDF sale como en Chrome.** El CSS que genera Tailwind es predecible
  (una clase, una propiedad, sin selectores complejos), justo lo que el motor
  reproduce mejor: las plantillas Tailwind de prueba promedian 97 % de
  similitud con Chrome y la factura llega a 100 %.
- **Los errores se ven antes de producción.** Una clase mal escrita no da
  error en el navegador, pero aquí aparece en `warnings`, y
  `typst-pdf check --strict` lo detiene en CI.
- **Un template es un solo HTML.** Fácil de guardar en una fila de la base de
  datos, revisar en un PR, editar sin afectar a otros documentos y generar
  con IA o copiar desde un diseño de Tailwind UI.
- **El equipo ya lo conoce.** No hace falta aprender qué CSS soporta el
  motor: las utilidades de Tailwind están probadas.

`typst-pdf new` crea los templates con Tailwind. Para CSS puro existe
`--plain` o `tailwind: false`.

Lo que conviene saber:

- **El ancho de la página es la pantalla.** Una hoja A4 vertical mide 794 px:
  aplican `sm:` (640 px) y `md:` (768 px), pero no `lg:` ni `xl:`. Diseña
  *mobile first* sin prefijo o con `md:`. En A4 horizontal (1123 px) también
  aplica `lg:`. El tamaño se toma de `page.size` o de `@page { size }`.
- **`print:` siempre aplica** (`print:hidden`, `print:text-black`): sirve para
  reutilizar en el PDF un HTML que también se muestra en pantalla.
- **`hover:`, `focus:`, `dark:` y similares nunca aplican**, y lo avisan.
- **Tema propio** en el CSS del template, con `@theme { --color-marca: #0f766e; --font-sans: Marca, sans-serif; }`,
  y componentes con `@apply` o `@utility`. Las fuentes `font-sans`,
  `font-serif` y `font-mono` usan las fuentes del PDF (Inter, Libertinus
  Serif, DejaVu Sans Mono) salvo que las cambies.
- **No se soportan `@plugin` ni `tailwind.config.js`**, porque no se ejecuta
  JavaScript: todo se configura en CSS. Si un template lo usa, el error lo
  explica.
- **CSS puro:** usa `tailwind: false` (en el template o en `createTemplates`).
  Así no se aplica el *preflight* de Tailwind, que quita márgenes y tamaños
  por defecto de `h1`, `p`, listas, etc.

## Seguridad

- **Datos:** `{{valor}}` escapa el HTML; usa `{{{valor}}}` solo con HTML en el
  que confías. Handlebars no permite acceder a propiedades del prototipo.
- **Templates desde la base de datos:** son código (HTML/CSS), trátalos como
  tal. Las rutas relativas (imágenes, `<link>`, `@import`) no salen de
  `baseDir`; sin `baseDir`, los archivos locales se rechazan. Las imágenes
  remotas siguen las reglas de `assets` (desactivadas por defecto, con
  protección SSRF).
- **Google Fonts:** solo se descargan hojas de `fonts.googleapis.com` y
  archivos de `fonts.gstatic.com`, de hasta 10 MB.
- **`typst-pdf dev`** escucha solo en `127.0.0.1`, rechaza otros nombres de
  host (DNS rebinding) y muestra el HTML sin ejecutar scripts. No lo expongas
  en un servidor.

## Buenas prácticas

- **Usa Tailwind** y revisa los avisos: una clase mal escrita no genera CSS y
  no da error en el navegador, pero aquí aparece en `warnings`. Deja el CSS
  propio para `@theme` (colores y fuentes de tu marca) y `@utility`.
- **No nombres campos como un helper** (`number`, `date`, `money`, `sum`…):
  `{{number}}` llama al helper, no al campo. Usa `folio`, `fecha`, etc.
- **Margen en la página, no en el HTML.** Con `page.margin` (o
  `@page { margin }`) todas las páginas lo tienen; un `p-10` en el contenedor
  solo separa el inicio y el final del documento. En tablas largas, agrega
  `break-inside-avoid` al bloque de totales.
- **Diseña mirando la vista previa** (`typst-pdf dev`), no el navegador: el PDF
  es lo que verá tu usuario.
- **Calcula en los datos, presenta en el template.** Totales, impuestos y
  textos condicionales complejos quedan más claros en tu código. El template
  solo los formatea.
- **Corre `typst-pdf check --strict` en CI** para detectar CSS no soportado
  antes de desplegar.
- **Usa `allowedHosts`** si los templates cargan imágenes remotas.
