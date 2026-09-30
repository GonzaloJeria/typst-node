# typst-node

Generación de PDF en Node.js sin navegador: HTML/CSS → Typst → PDF.

| Paquete | Estado |
|---|---|
| [`typst-compiler`](packages/typst-compiler) | `TypstBackend` + `CliBackend` (binario oficial de Typst por documento) + `SidecarBackend` (procesos Typst persistentes); cero dependencias de runtime |
| [`typst-html-pdf`](packages/pdf) | Fachada `htmlToPdf()` / `PdfRenderer`: transpila, resuelve imágenes (data URI, archivos locales acotados a `baseDir`, HTTP con protección SSRF) y compila |
| [`typst-sidecar`](crates/typst-sidecar) | Binario Rust propio sobre los crates oficiales de Typst: compila por JSON sobre stdin/stdout sin reiniciar entre documentos |
| [`html-to-typst`](packages/html-to-typst) | HTML/CSS → IR → Typst: parse5, cascada CSS propia (selectores, especificidad, herencia, shorthands, `@page`, `@media print`), tablas con rowspan/colspan, flex/grid básicos, saltos de página |

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
import { PdfRenderer } from "typst-html-pdf";

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

| | `CliBackend` (por defecto) | `SidecarBackend` |
|---|---|---|
| Qué ejecuta | un proceso `typst compile` por documento | procesos `typst-sidecar` que quedan vivos |
| Factura (2 págs., datos distintos por PDF), p50 | 34 ms | 10 ms |
| Throughput factura, 4 vCPU | ~100 PDF/s | ~270 PDF/s |
| Documento con bloque de código resaltado | 154 ms | 4 ms |
| Memoria | ~30 MB por compilación en curso | ~60 MB por proceso, estable |
| Requiere | binario oficial `typst` | binario `typst-sidecar` (compilar o descargar del release) |

Los dos producen los mismos píxeles (los tests visuales corren con ambos). El
sidecar se reinicia solo si se cae, si excede el timeout o cada
`maxCompilationsPerProcess` documentos. No soporta paquetes de Typst Universe
(`@preview/…`), que el transpilador no usa.

```sh
cargo build --release --manifest-path crates/typst-sidecar/Cargo.toml
export TYPST_SIDECAR_PATH=$PWD/crates/typst-sidecar/target/release/typst-sidecar
```

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
import { htmlToTypst } from "html-to-typst";

const { source, warnings, assets } = htmlToTypst(html);
// assets: rutas de <img> para resolver y pasar como `files` al compilador
```

```ts
import { CliBackend } from "typst-compiler";

const typst = new CliBackend({ maxConcurrency: 4, timeoutMs: 10_000 });
await typst.verify(); // falla pronto si no hay binario

const { pdf, warnings } = await typst.compile({
  source: '#image("logo.png", width: 3cm)\n= Hola #sys.inputs.name',
  files: new Map([["logo.png", logoBytes]]),
  fonts: [interBytes],
  inputs: { name: "Ada" },
});
```

## En producción

Se publican los tres paquetes de npm (la fachada depende de los otros dos), pero
una aplicación solo instala `typst-html-pdf`. El binario `typst-sidecar` se
distribuye aparte (release de GitHub o imagen Docker), como el binario de Typst.

```dockerfile
FROM rust:1-bookworm AS sidecar
COPY crates/typst-sidecar /src
RUN cargo build --release --locked --manifest-path /src/Cargo.toml

FROM node:22-bookworm-slim
COPY --from=sidecar /src/target/release/typst-sidecar /usr/local/bin/
COPY fonts /app/fonts
ENV TYPST_SIDECAR_PATH=/usr/local/bin/typst-sidecar
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY dist ./dist
CMD ["node", "dist/server.js"]
```

```ts
import { PdfRenderer, TypstCompileError } from "typst-html-pdf";

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

## Soporte de HTML/CSS

**Soportado:** cascada con especificidad, `!important`, herencia y variables CSS
(`var()` con fallback, `:root`); `calc()` simple; colores hex/rgb/hsl con
transparencia; `opacity` (aproximada: se aplica al texto, al fondo y al borde
del elemento); fondos con color o `linear-gradient`/`radial-gradient`; padding,
bordes (sólidos, `dashed`, `dotted`) y `border-radius`, también en elementos
inline (badges, chips); `text-transform`; `::before`/`::after` con `content`
(strings con escapes, `attr()`, comillas); `list-style` (marcadores, numeración
alfabética y romana, `none`); tablas con rowspan/colspan; flex en fila y grid
explícito; `@page`; saltos de página.

**Posicionamiento y efectos:** `position: absolute` (anclado a la esquina que
indiquen `top`/`right`/`bottom`/`left`, dentro del ancestro posicionado más
cercano), `position: relative` con desplazamientos (también en línea),
`position: fixed` (se repite en cada página, relativo a los bordes de la hoja);
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
palabras clave, `no-repeat`), recortadas al `border-radius`. `@page { background: url(…) }` pinta una imagen
detrás de cada página (marcas de agua, membretes).

**Columnas:** `column-count`, `columns: N` y `column-gap`, con columnas
balanceadas como en CSS cuando el bloque cabe en la página (si no, el texto
fluye columna a columna entre páginas). Ideal para términos y condiciones.

**Espaciado:** márgenes horizontales (`pad` en bloques, espacio en elementos
inline, combinables con `auto`) y `line-height` (número, %, longitud;
`normal` ≈ 1.2).

**Todavía no:** `float`, fondos repetidos (`repeat`) o con varias capas, sombras `inset`, `skew`/`matrix`, desplazamientos en `%`,
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
