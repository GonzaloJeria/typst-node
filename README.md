# typst-node

Generación de PDF en Node.js sin navegador: HTML/CSS → Typst → PDF.

| Paquete | Estado |
|---|---|
| [`@gjeria/typst-compiler`](packages/typst-compiler) | `TypstBackend` + `CliBackend` (binario oficial de Typst por documento) + `SidecarBackend` (procesos Typst persistentes); cero dependencias de runtime |
| [`@gjeria/pdf-templates`](packages/templates) | Templates Handlebars + Tailwind desde archivos o base de datos, Google Fonts, y la CLI `typst-pdf` con vista previa en vivo |
| [`@gjeria/typst-html-pdf`](packages/pdf) | Fachada `htmlToPdf()` / `PdfRenderer`: transpila, resuelve imágenes (data URI, archivos locales acotados a `baseDir`, HTTP con protección SSRF) y compila |
| [`typst-sidecar`](crates/typst-sidecar) | Binario Rust propio sobre los crates oficiales de Typst: compila por JSON sobre stdin/stdout sin reiniciar entre documentos |
| [`@gjeria/html-to-typst`](packages/html-to-typst) | HTML/CSS → IR → Typst: parse5, cascada CSS propia (selectores, especificidad, herencia, shorthands, `@page`, `@media print`), tablas con rowspan/colspan, flex/grid básicos, saltos de página |

## Requisitos

- Node ≥ 20, pnpm 10
- Binario oficial de [Typst](https://github.com/typst/typst/releases) en el `PATH` o en `TYPST_PATH` (probado con 0.15.1). Sin él, los tests de integración se omiten.

```sh
pnpm install
pnpm test        # vitest (todos los paquetes)
pnpm typecheck
pnpm build       # tsup → ESM + CJS + .d.ts
```

## Uso

```ts
import { PdfRenderer } from "@gjeria/typst-html-pdf";

const renderer = new PdfRenderer({
  defaults: {
    assets: { baseDir: "./templates", allowRemote: true, allowedHosts: ["cdn.example.com"] },
    fonts: [interBytes],
    genericFamilies: { "sans-serif": ["Inter"] },
  },
});
const { pdf, warnings } = await renderer.render(html);
await renderer.dispose();
```

Por defecto las imágenes remotas están desactivadas. Al activarlas, se bloquean
las IP privadas, de loopback y link-local, validando la IP exacta al conectar
(protege también contra DNS rebinding). Las redirecciones se vuelven a validar
en cada salto, y hay límites de tamaño y timeout.

### Backends: CLI o sidecar

| | `CliBackend` | `SidecarBackend` (por defecto) |
|---|---|---|
| Qué ejecuta | un proceso `typst compile` por documento | procesos `typst-sidecar` que quedan vivos |
| Factura (2 págs., datos distintos por PDF), p50 | 34 ms | 10 ms |
| Throughput factura, 4 vCPU | ~100 PDF/s | ~270 PDF/s |
| Documento con bloque de código resaltado | 154 ms | 4 ms |
| Memoria | ~30 MB por compilación en curso | ~60 MB por proceso, estable |
| Requiere | binario oficial `typst` en el PATH | nada: viene en el paquete npm de la plataforma |

Los dos producen los mismos píxeles (los tests visuales corren con ambos). El
sidecar se reinicia solo si se cae, si excede el timeout o cada
`maxCompilationsPerProcess` documentos. No soporta paquetes de Typst Universe
(`@preview/…`), que el transpilador no usa.

En el repo, `pnpm sidecar:build` compila el binario para la máquina local y lo
deja en `npm/typst-sidecar-<plataforma>-<arquitectura>/bin`, donde lo encuentra
igual que en una instalación de npm (en Linux necesita `musl-tools` y
`CC_x86_64_unknown_linux_musl=musl-gcc`). `TYPST_SIDECAR_PATH` permite usar otro binario.

```ts
const renderer = new PdfRenderer({ sidecar: { processes: 4, timeoutMs: 10_000 } });
await renderer.warmup(); // arranca los procesos antes del primer request
```

### Plantillas y secciones

Para documentos con una base común (encabezado, pie, estilos) y partes con
diseño distinto, `render` acepta secciones en vez de un HTML. Cada sección
empieza en una página nueva, su CSS solo se aplica a ella y la numeración es
continua en todo el documento:

```ts
const { pdf } = await renderer.render({
  layout: {
    css: "body { font-family: Inter }",
    page: {
      size: "A4",
      margin: "25mm 18mm",
      header: '<img src="logo.svg" style="width: 30mm">',
      footer: "Página {{page}} de {{pages}}",
    },
  },
  sections: [
    { html: portada, css: portadaCss, page: { margin: "0", header: false, background: "#0f172a" } },
    { html: terminos, css: "body { font-size: 8pt }" },
  ],
});
```

`page` acepta `size`, `margin`, `background`, `header` y `footer` (HTML, o
`false` para quitarlo); lo que defina una sección reemplaza al del layout.

Lo mismo se puede hacer en un solo HTML con CSS estándar de páginas con nombre:

```css
@page legal { margin: 15mm; @top-center { content: none } }
@page :first { background: #0f172a; @top-center { content: none } }
.terminos { page: legal }
```

### Otros paquetes

```ts
import { htmlToTypst } from "@gjeria/html-to-typst";

const { source, warnings, assets } = htmlToTypst(html);
// assets: rutas de <img> para resolver y pasar como `files` al compilador
```

```ts
import { CliBackend } from "@gjeria/typst-compiler";

const typst = new CliBackend({ maxConcurrency: 4, timeoutMs: 10_000 });
await typst.verify(); // falla pronto si no hay binario

const { pdf, warnings } = await typst.compile({
  source: '#image("logo.png", width: 3cm)\n= Hola #sys.inputs.name',
  files: new Map([["logo.png", logoBytes]]),
  fonts: [interBytes],
  inputs: { name: "Ada" },
});
```

## Guía de uso y buenas prácticas

**¿Generas PDFs desde templates?** (HTML con variables, guardado en archivos o
en la base de datos). Usa [`@gjeria/pdf-templates`](packages/templates): se
encarga de Handlebars, Tailwind, Google Fonts y los `<script>`/`<link>` del
HTML, y trae la vista previa en vivo:

```sh
npm i @gjeria/pdf-templates
npx typst-pdf new factura && npx typst-pdf dev
```

```ts
import { createTemplates } from "@gjeria/pdf-templates";

const templates = createTemplates({ source: async (nombre) => db.plantillas.findOne({ nombre }) });
const { pdf } = await templates.render("orden-de-compra", datos);
```

Lo que sigue describe la librería base, `@gjeria/typst-html-pdf`. Las reglas
básicas:

1. **Un `PdfRenderer` por proceso**, creado al arrancar, nunca uno por
   request: cada uno levanta sus propios procesos de Typst.
2. **`await renderer.warmup()`** antes de aceptar tráfico, para que el primer
   PDF no pague el arranque.
3. **`renderer.dispose()`** al apagar (`SIGTERM`), para cerrar los procesos.
4. **Prefiere Tailwind** (`tailwind: true`), que da el resultado más fiel a
   Chrome. El resto del CSS va en el HTML (`<style>`) o en la opción `css`: la
   librería no ejecuta JavaScript ni descarga `<link rel="stylesheet">`.
5. **Revisar `warnings`** mientras desarrollas: lista cada propiedad o valor
   que se descartó o aproximó. En tests, `strict: true` convierte esos
   warnings en error.
6. **Escapar los datos** que insertas en el HTML (nombres, direcciones,
   descripciones): usa un motor de plantillas que escape (Handlebars,
   EJS con `<%= %>`, JSX/`renderToStaticMarkup`) o escapa tú `& < > " '`.

### Opciones

```ts
const renderer = new PdfRenderer({
  // Backend: por defecto el sidecar (procesos Typst persistentes, el más rápido).
  sidecar: {
    processes: 2,                    // documentos en paralelo; por defecto, nº de CPUs (~60 MB c/u)
    timeoutMs: 15_000,               // por documento; el proceso que se pasa se reinicia
    maxCompilationsPerProcess: 500,  // recicla procesos para acotar la memoria
    fonts: [{ dir: "/app/fonts" }],  // fuentes para todos los documentos
    creationTimestamp: 0,            // fecha fija: PDFs idénticos byte a byte (tests)
  },
  bundledFonts: true,                // Inter como sans-serif (por defecto)
  defaults: {                        // se mezclan con las opciones de cada render
    css: baseCss,                    // CSS aplicado después del <style> del documento
    rootFontSize: 12,                // tamaño raíz en pt (16px del navegador = 12pt)
    tailwind: true,                  // Tailwind CSS v4 incluido: CSS para las clases del HTML
    strict: false,
    genericFamilies: { "sans-serif": ["Inter"], serif: ["Libertinus Serif"] },
    fontAliases: { "Mi Marca": "MiMarca Sans" },
    assets: {
      baseDir: "/app/templates",     // rutas relativas y file: (sin baseDir se rechazan)
      allowRemote: true,             // http(s): imágenes y @font-face; NO hojas de estilo
      allowedHosts: ["cdn.miempresa.com", /\.amazonaws\.com$/],
      timeoutMs: 10_000,
      maxAssetBytes: 10 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
      onError: "skip",               // imagen que falla: warning en vez de error
      resolve: async (src) => undefined, // resolver propio (S3, BD…); undefined = el normal
    },
  },
});
```

Cada llamada acepta las mismas opciones (`renderer.render(html, { css, assets,
fonts, timeoutMs, signal })`) y se combinan con `defaults`: el `css` se
concatena, `assets` y `fonts` se mezclan.

El resultado trae `pdf` (`Uint8Array`), `warnings` (lo que el transpilador
descartó o aproximó), `diagnostics` (avisos del compilador Typst) y `source`
(el Typst generado, útil para depurar).

### Casos de uso

**HTML suelto.** Si no hay `<html>`/`<head>`, igual funciona: el CSS va en la
opción `css`.

```ts
const { pdf } = await renderer.render("<h1>Hola</h1><p>Mundo</p>", { css: "h1 { color: #2563eb }" });
```

**Tamaño y márgenes de página.** Sin `@page { margin }` la página no tiene
margen, como en el `page.pdf()` de Puppeteer y Playwright; los encabezados y
pies de página (cajas `@top-*`/`@bottom-*` o `header`/`footer` de las
secciones) reservan un margen por defecto. Con CSS estándar:

```css
@page { size: A4; margin: 20mm 15mm }          /* también letter, A4 landscape, 210mm 297mm */
@page { @bottom-center { content: "Página " counter(page) " de " counter(pages) } }
.salto { break-before: page }                   /* o page-break-before: always */
tr, .tarjeta { break-inside: avoid }
```

**Encabezado con logo en cada página.** Con `position: running()`:

```html
<style>
  .header { position: running(header) }
  @page { margin-top: 30mm; @top-center { content: element(header) } }
</style>
<div class="header"><img src="logo.svg" style="height: 12mm"></div>
```

O con secciones (ver [Plantillas y secciones](#plantillas-y-secciones)), que
además permiten portada sin encabezado y CSS distinto por parte.

**Tailwind CSS v4 (recomendado).** Viene incluido: no hay nada que instalar.
Con `@gjeria/pdf-templates` está activado por defecto; con la librería base
se activa con `tailwind: true`:

```ts
const html = `<div class="p-8 text-slate-800"><h1 class="text-2xl font-bold text-blue-600">Factura</h1></div>`;
const { pdf, warnings } = await renderer.render(html, { tailwind: true });
```

Se genera CSS solo para las clases que usa el HTML. Los `<style>` del
documento y la opción `css` pasan por Tailwind, así que pueden usar `@theme`,
`@apply` y `@utility`. El `<script>` del CDN de Tailwind se ignora, porque el
CSS ya está generado. `warnings` avisa de lo que no funciona en papel:

- clases que no existen (`txt-red-500`)
- breakpoints más anchos que la página (`lg:` en A4, que mide 794 px)
- estados como `hover:` o `dark:`

`print:` siempre aplica. No se soportan `@plugin` ni `tailwind.config.js`,
porque toda la configuración va en CSS. Para usarlo en otro flujo, la librería
exporta `tailwindCss(html, css)`.

**Bootstrap 5.** Lee el CSS del paquete y pásalo tal cual:

```ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const bootstrapCss = readFileSync(createRequire(import.meta.url).resolve("bootstrap/dist/css/bootstrap.min.css"), "utf8");
const renderer = new PdfRenderer({ defaults: { css: bootstrapCss } });
```

**Breakpoints.** `@media` se evalúa contra el ancho de la página, como Chrome
al imprimir: A4 vertical mide ~794px, así que aplican `sm:` (640px) y `md:`
(768px) pero no `lg:` (1024px) ni mayores; en Bootstrap aplican `-sm` y `-md`.
`print:` y `@media print` aplican; `hover:`, `focus:` y `dark:` no.

**Imágenes.** `data:` URI siempre funcionan; rutas relativas con
`assets.baseDir`; URLs con `allowRemote` (mejor con `allowedHosts`). Para
imágenes privadas (S3, base de datos), `resolve` devuelve los bytes:

```ts
assets: {
  resolve: async (src) => (src.startsWith("s3://") ? await descargarDeS3(src) : undefined),
}
```

**Fuentes propias.** Con `@font-face` en el CSS (TTF/OTF; ver
[Fuentes incluidas](#fuentes-incluidas)), o para todos los documentos con
`sidecar.fonts: [{ dir: "/app/fonts" }]` y luego `font-family: "Nombre"`.

**Vista previa como imagen.** `renderPages` devuelve un PNG (o SVG) por
página:

```ts
const { pages } = await renderer.renderPages(html, { format: "png", ppi: 96 });
```

**Script o tarea suelta.** `htmlToPdf(html, opciones)` usa un renderer
compartido; llama a `disposeDefaultRenderer()` al terminar.

**Cancelar.** `signal` corta la descarga de imágenes y la compilación:

```ts
await renderer.render(html, { signal: AbortSignal.timeout(20_000) });
```

### Errores

| Error | Cuándo |
|---|---|
| `TranspileError` (`err.name`) | `strict: true` y el HTML usa algo no soportado; `err.warnings` lo lista |
| `AssetError` | una imagen o fuente no se pudo cargar (host no permitido, 404, tamaño) y `onError` es `throw` |
| `TypstCompileError` | Typst no pudo compilar (no debería pasar con HTML; repórtalo con `source`) |
| `TypstTimeoutError` | el documento superó `timeoutMs` |

### Servir el PDF por HTTP

Devuelve los bytes, no base64 (pesa un 33 % más y obliga al cliente a
decodificar):

```ts
res.setHeader("Content-Type", "application/pdf");
res.setHeader("Content-Disposition", 'inline; filename="factura.pdf"');
res.end(Buffer.from(pdf));
```

### Lo que no funciona (y qué hacer)

| En el navegador | Aquí |
|---|---|
| `<script>`, CDN de Tailwind | `tailwind: true` (o `@gjeria/pdf-templates`) |
| `<link rel="stylesheet">` | leer el archivo y pasarlo en `<style>` o `css` |
| formularios, video, canvas, iframe | se omiten con warning; usa texto o imágenes |
| `:hover`, modo oscuro | nunca aplican en papel |
| WOFF/WOFF2 | convertir a TTF/OTF |
| `float` | usar flex o grid |

Ver [Soporte de HTML/CSS](#soporte-de-htmlcss) para el detalle.

## Migrar desde Puppeteer o Playwright

| Puppeteer / Playwright | typst-node |
|---|---|
| `browser.newPage()` + `page.setContent(html)` + `page.pdf()` | `renderer.render(html)` (un `PdfRenderer` por proceso) |
| `page.pdf({ format: "A4", margin })` | `@page { size: A4; margin: 15mm }` en el CSS, o `page` en secciones/templates |
| `displayHeaderFooter`, `headerTemplate`, `footerTemplate` | `page.header` / `page.footer` (con `{{page}}` y `{{pages}}`), o `@top-center`/`@bottom-center` |
| `<script src="https://cdn.tailwindcss.com">` | `tailwind: true` (incluido) o `@gjeria/pdf-templates` |
| `<link rel="stylesheet" href="…">` | el CSS en `<style>`, la opción `css`, o una hoja local en un template |
| `printBackground: true` | siempre activo |
| `page.waitForNetworkIdle()` / imágenes remotas | `assets: { allowRemote: true, allowedHosts: [...] }` (se descargan antes de compilar) |
| JavaScript que arma el HTML en el navegador (gráficos, `document.write`) | genera el HTML en Node (Handlebars, JSX) y los gráficos como SVG |
| `emulateMediaType("print")` | siempre es impresión: `@media print` y `print:` aplican |

Diferencias a tener en cuenta:

- **Sin `@page { margin }`, la página no tiene margen**, igual que `page.pdf()`
  sin `margin`. Si antes pasabas `margin` en `page.pdf()`, ponlo en `@page`.
- **No hay JavaScript.** Lo que en el navegador calcula un script (totales,
  gráficos con Chart.js) se calcula antes, en Node.
- **Fuentes:** `sans-serif` es Inter (incluida); las demás se declaran con
  `@font-face` (TTF/OTF) o con un `<link>` a Google Fonts en
  `@gjeria/pdf-templates`.
- **Revisa `warnings`:** lista todo lo que no se pudo representar, en vez de
  fallar en silencio.

## En producción

Una aplicación solo instala `@gjeria/typst-html-pdf`. El motor viene incluido:
`@gjeria/typst-compiler` declara como dependencias opcionales los paquetes
`@gjeria/typst-sidecar-<plataforma>-<arquitectura>` (Linux x64/arm64 estático,
macOS x64/arm64, Windows x64) y npm instala solo el que corresponde, como hace
esbuild. Sin Chromium, sin instalar Typst, sin paquetes del sistema.

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev          # trae el binario typst-sidecar de linux-x64
COPY fonts ./fonts
COPY dist ./dist
CMD ["node", "dist/server.js"]
```

```ts
import { PdfRenderer, TypstCompileError } from "@gjeria/typst-html-pdf";

// Uno por proceso de Node, creado al arrancar.
const renderer = new PdfRenderer({
  sidecar: { processes: 4, timeoutMs: 15_000, fonts: [{ dir: "/app/fonts" }] },
  defaults: {
    strict: false,
    genericFamilies: { "sans-serif": ["Inter"], serif: ["Source Serif 4"] },
    assets: { baseDir: "/app/templates", allowRemote: true, allowedHosts: ["cdn.miempresa.com"] },
  },
});
await renderer.warmup();

const { pdf, warnings } = await renderer.render({
  layout: { css: baseCss, page: { size: "A4", margin: "22mm 18mm", header: headerHtml, footer: "{{page}} / {{pages}}" } },
  sections: [
    { html: renderTemplate("factura", data), css: facturaCss },
    { html: terminosHtml, page: { header: false } },
  ],
}, { signal: AbortSignal.timeout(20_000) });

process.on("SIGTERM", () => renderer.dispose());
```

### Fuentes incluidas

`sans-serif` y `system-ui` usan **Inter** (Regular, Italic, Bold, Bold Italic;
SIL OFL), incluida en `@gjeria/typst-html-pdf` (1,4 MB). `serif` usa Libertinus
Serif y `monospace` DejaVu Sans Mono, que vienen dentro de Typst. Un
`font-family: Arial, sans-serif` cae en Inter si Arial no está instalada. El
renderer agrega las fuentes solo; si creas tu propio backend, pásale
`fonts: [{ dir: bundledFontsDir }]`, y con `bundledFonts: false` las desactivas.

Tus propias fuentes se declaran en el CSS con `@font-face`, como en el
navegador:

```css
@font-face { font-family: Marca; src: url(fonts/Marca-Regular.ttf) format("truetype") }
body { font-family: Marca, sans-serif }
```

El archivo se carga con las mismas reglas que las imágenes (`assets.baseDir`,
`data:` o `allowRemote`), y si el nombre del CSS (`Marca`) no coincide con el
nombre de la familia dentro del archivo, la librería lo traduce sola. Typst
solo lee **TTF y OTF**: una fuente que solo está en WOFF/WOFF2 se ignora con un
warning (si el `src` ofrece varias, se usa la TTF/OTF). Cada `@font-face` aporta
un archivo; para negrita y cursiva declara los cuatro con el mismo nombre.

### Memoria y costo (Cloud Run)

Medido en Linux x64 con el binario publicado (musl estático + jemalloc),
compilando 300 documentos de la suite sin reiniciar:

| Proceso | Arranque | Estable | Qué lo ocupa |
|---|---|---|---|
| `typst-sidecar` | 15 MB | ~63 MB | fuentes, biblioteca estándar de Typst, caché de layout (se poda cada documento) |
| Node + librería | 65 MB | ~105 MB | V8 (42 MB vacío), parse5 y el transpilador (~15 MB) |
| Node con `--max-old-space-size=64 --max-semi-space-size=1` | 65 MB | ~78 MB | mismo trabajo, el GC libera antes |

Total: **~140 MB** por instancia con un proceso sidecar. Cada proceso extra de
`sidecar.processes` suma ~60 MB; su valor por defecto es el número de CPUs, que
en Cloud Run con 1 vCPU es 1. El reciclado (`maxCompilationsPerProcess`, 500 por
defecto) evita que la memoria del sidecar crezca con el tiempo.

Configuración más barata recomendada:

```bash
gcloud run deploy pdf --source . \
  --cpu 1 --memory 256Mi --concurrency 8 \
  --min-instances 0 --max-instances 10 \
  --execution-environment gen1 --cpu-boost \
  --set-env-vars NODE_OPTIONS="--max-old-space-size=64 --max-semi-space-size=1"
```

- En Cloud Run la memoria pesa poco en la factura: 1 vCPU cuesta ~10 veces más
  por segundo que 1 GiB. Bajar de 512 MiB a 256 MiB ahorra ~2,5 %; lo que manda es
  el tiempo de CPU por documento (~5–10 ms aquí).
- `gen1` permite 256 MiB (gen2 exige 512 MiB mínimo) y arranca más rápido.
- Con menos de 1 vCPU Cloud Run fuerza `concurrency 1`; con 1 vCPU un solo
  sidecar atiende en cola a varias solicitudes concurrentes sin memoria extra.
- Si mandas imágenes grandes o generas PNG, deja 512 MiB: la rasterización
  llega a ~75 MB de pico en el sidecar.

## Publicar en npm

Las versiones y los CHANGELOG salen de `.changeset/` (`pnpm changeset` para
registrar un cambio, `pnpm changeset version` para aplicar los pendientes; todos
los paquetes `@gjeria/*` comparten versión).

La publicación la hace el workflow **Release** (Actions → Release → Run
workflow): compila `typst-sidecar` para las 5 plataformas, corre los tests y
publica con provenance todo lo que no esté en npm. Requiere el secreto
`NPM_TOKEN` (token *Automation* de npm con acceso al scope `@gjeria`). Publicar
desde una máquina local no sirve: los paquetes de plataforma se negarían a
publicarse sin su binario.

## Soporte de HTML/CSS

**Soportado:** cascada con especificidad, `!important`, herencia y variables CSS
(`var()` con fallback, `:root`); `calc()` simple; colores hex/rgb/hsl con
transparencia; `opacity` (aproximada: se aplica al texto, al fondo y al borde
del elemento); fondos con color o `linear-gradient`/`radial-gradient`; padding,
bordes (sólidos, `dashed`, `dotted`) y `border-radius` (también distinto por
esquina, como `rounded-t-lg`), también en elementos
inline (badges, chips); `text-transform`; `::before`/`::after` con `content`
(strings con escapes, `attr()`, comillas); `list-style` (marcadores, numeración
alfabética y romana, `none`); tablas con rowspan/colspan; flex en fila (con `justify-content` y
`align-items`) y grid
explícito; `@page`; saltos de página.

**CSS moderno (Tailwind, Bootstrap):** el CSS compilado de Tailwind v4 y
Bootstrap 5 se lee completo: `@layer` (con su orden de cascada), `@media`
evaluado contra el tamaño de la página (`print` sí, `screen` no; los
breakpoints `min-width`/`width >=` se comparan con el ancho de `@page`, como
hace Chrome al imprimir), `@supports`, `@property` (valores iniciales de
variables), anidado de reglas (`&`), selectores nivel 4 (`:is()`, `:where()`,
`:not()`, `:has()`, `+`, `~`, `:nth-child(An+B of S)`, `:*-of-type`,
`:empty`, clases escapadas como `.md\:flex` o `.w-1\/2`), colores
`oklch()`/`oklab()`/`lab()`/`lch()`/`hwb()`/`color()`/`color-mix()`,
`min()`/`max()`/`clamp()`, unidades `vw`/`vh` (relativas al área de la página, dentro de los márgenes),
`ch`/`ex`/`lh`, propiedades lógicas (`padding-inline`, `margin-block-start`,
`inset-inline`…), el shorthand `font`, `box-sizing` en anchos y altos,
`grid-template-columns` con `repeat()` y `minmax()`, y texto suelto dentro de
flex/grid.

**Layout como en el navegador:** `line-height` arma cajas de línea como CSS
(el espacio extra se reparte arriba y abajo de cada línea, según las métricas
de la fuente); los bloques se separan solo por sus márgenes, que colapsan
entre hermanos (también los negativos) y se conservan al inicio de la página y
dentro de ítems flex/grid; márgenes por defecto del navegador para `h1`–`h6`,
`p`, listas y `blockquote`; viñetas y números colgando en el `padding` de la
lista; `flex-wrap: wrap` (ítems en `%` se reparten en filas, como la grilla
`.row`/`.col-*` de Bootstrap; los demás fluyen y saltan de línea, como
etiquetas o chips); `flex-direction: column` con `align-items` y `gap`;
`row-gap`/`column-gap`; `calc()` que mezcla `%` con longitudes
(`calc(100% - 2rem)`); `justify-content` en columnas flex con alto o
`min-height` (un pie de página empujado al final con `justify-between`);
`min-height` que deja al contenido usar el alto libre; filas de tabla con
altura, tablas con ancho propio, bordes en `<tr>` y padding distinto por
celda. Estados interactivos (`:hover`, `:focus`…) nunca aplican en papel y
no generan warnings. Si un valor no se puede renderizar y la regla traía un
fallback (`display: block; display: -webkit-box`), se usa el fallback.

**Posicionamiento y efectos:** `position: absolute` (anclado a la esquina que
indiquen `top`/`right`/`bottom`/`left`, dentro del ancestro posicionado más
cercano), `position: relative` con desplazamientos (también en línea); los hijos
`absolute` se miden desde el borde interior del padding y no cuentan como
ítems flex/grid;
`position: fixed` (se repite en cada página, relativo al área dentro de los márgenes, como al
imprimir en un navegador; con `left` y `right` ocupa el ancho entre ambos); `<svg>` inline;
`transform` con `rotate`, `scale` y `translate`; `box-shadow` exterior con
difuminado aproximado (la caja con sombra no se parte entre páginas).

**Página:** fondo de página desde `@page { background }` o desde el fondo de
`body`/`html`; encabezado y pie con las cajas de margen `@top-left|center|right`
y `@bottom-left|center|right`, con `content` de texto, `counter(page)`,
`counter(pages)` y `element(nombre)` para mover al margen HTML marcado con
`position: running(nombre)` (por ejemplo, un logo). `counter(page)` y
`counter(pages)` también funcionan en `::before`/`::after`. Páginas con nombre
(`page: nombre` + `@page nombre { … }`, en elementos de primer nivel) con su
propio tamaño, márgenes, fondo y cajas de margen; `@page :first` con fondo y
cajas de margen distintas en la primera página.

**Cajas:** `height` y `min-height` (longitudes o `%`, respetando
`box-sizing`); imágenes de fondo con `background-image: url()` o el shorthand
`background` (`cover`, `contain`, `100% 100%` o un tamaño, posición con
palabras clave, `no-repeat`), recortadas al `border-radius`. `overflow: hidden`
(o `clip`, `auto`, `scroll`: en papel no hay scroll) recorta el contenido a la
caja y a sus esquinas redondeadas. Imágenes con ancho y alto respetan
`object-fit` (`fill` por defecto, `cover`, `contain`). `@page { background: url(…) }` pinta una imagen
detrás de cada página (marcas de agua, membretes).

**Columnas:** `column-count`, `columns: N` y `column-gap`, con columnas
balanceadas como en CSS cuando el bloque cabe en la página (si no, el texto
fluye columna a columna entre páginas). Ideal para términos y condiciones.

**Espaciado:** márgenes horizontales (`pad` en bloques, espacio en elementos
inline, combinables con `auto`) y `line-height` (número, %, longitud;
`normal` ≈ 1.2).

**Todavía no:** `min()`/`max()` que
comparan `%` con longitudes, `@container`, fuentes WOFF/WOFF2, `float`, fondos repetidos (`repeat`) o con varias capas, sombras `inset`, `skew`/`matrix`, desplazamientos en `%`,
márgenes o tamaño distintos en `@page :first`, `@page :left/:right`,
`@page nombre:first`, `column-width`, `column-rule`, `column-span`.

Nada se descarta en silencio: cada propiedad o valor que no se sabe renderizar
genera un warning, y con `strict: true` `htmlToTypst` lanza un `TranspileError`.

## Regresión visual

`packages/pdf/test/fixtures/*.html` se renderiza a PNG (50 ppi) y se compara píxel
a píxel contra `packages/pdf/test/visual/__goldens__/`. La tolerancia es de
24/255 por canal y un máximo de 0,1 % de píxeles distintos por página. Si falla,
los PNG renderizados y los de diferencia (en rojo) quedan en `test/visual/__diff__/`
(CI los sube como artefacto).

- Los goldens dependen de la versión de Typst (`__goldens__/TYPST_VERSION`, la misma que fija CI).
- Para aceptar un cambio visual intencional: `UPDATE_VISUAL=1 pnpm test`, revisar los PNG y hacer commit.
- En CI (`CI=true`) nunca se crean goldens faltantes: la prueba falla.
- Solo se usan las fuentes embebidas en Typst, así que emoji y CJK aparecen como tofu en los fixtures. Es lo esperado sin fuentes adicionales.

Además, una prueba de consistencia verifica que todo el texto del `<body>` llegue al IR (detecta contenido perdido).

### Comparación con Chrome

`pnpm test:chrome` imprime con Chromium (Playwright) las plantillas de
`packages/pdf/test/chrome/fixtures/` (Tailwind v4, Bootstrap 5 y CSS moderno
escrito a mano) y las compara con lo que genera la librería. Ambos PDF se
rasterizan con Typst a 40 ppi, Chrome usa la misma Inter incluida (vía
fontconfig) y el puntaje es el porcentaje de píxeles con contenido que
coinciden tras un leve desenfoque, así que mide layout y colores más que el
dibujo de cada letra.

- Los puntajes registrados están en `test/chrome/chrome-scores.json`; la prueba falla si una plantilla baja más de 2 puntos.
- Para registrar una mejora: `UPDATE_CHROME=1 pnpm test:chrome` y hacer commit del JSON.
- Las imágenes lado a lado (Chrome | librería | diferencia) y los warnings quedan en `test/chrome/__report__/`.
- No corre en CI (necesita Chromium); se salta sola si no lo encuentra (`CHROMIUM_PATH` para indicar la ruta).

| Plantilla | 0.1.1 | 0.2.0 |
| --- | --- | --- |
| Tailwind: factura | 81,8 % | 100 % |
| Tailwind: boleta térmica (80 mm) | — | 99,4 % |
| Tailwind: cotización (degradado, tarjetas, badges) | — | 98,6 % |
| Tailwind: estado de cuenta, 4 páginas (tabla larga, encabezado repetido) | — | 99,1 · 98,4 · 97,7 · 90,6 % |
| Tailwind: reporte (KPIs, gráfico SVG, barras) | — | 97,4 % |
| Tailwind: orden de compra (sin `@page`) | — | 97,2 % |
| Tailwind: certificado (A4 horizontal, serif) | — | 94,7 % |
| Tailwind: carta (texto corrido, serif) | — | 88,8 % |
| HTML simple, sin framework | 72,8 % | 99,8 % |
| Bootstrap 5 (reporte) | 67,5 % | 98,9 % |
| CSS moderno (capas, anidado, `oklch`) | 75,6 % | 98,4 % |
| Flex con `wrap`, columnas y `calc()` | 49,4 % | 98,3 % |
| Efectos (esquinas, `overflow`, `object-fit`, sombras) | — | 95,9 % |

Lo que más resta hoy son los cortes de línea en texto corrido largo (la carta):
cada motor mide el texto con pequeñas diferencias y una palabra puede pasar a
la línea siguiente.
