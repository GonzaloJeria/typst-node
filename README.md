# typst-node

Generación de PDF en Node.js sin navegador: HTML/CSS → Typst → PDF.

| Paquete | Estado |
|---|---|
| [`typst-compiler`](packages/typst-compiler) | `TypstBackend` + `CliBackend` (binario oficial de Typst, cero dependencias de runtime) |
| [`typst-html-pdf`](packages/pdf) | Fachada `htmlToPdf()` / `PdfRenderer`: transpila, resuelve imágenes (data URI, archivos locales acotados a `baseDir`, HTTP con protección SSRF) y compila |
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
`position: running(nombre)` (por ejemplo, un logo).

**Espaciado:** márgenes horizontales (`pad` en bloques, espacio en elementos
inline, combinables con `auto`) y `line-height` (número, %, longitud;
`normal` ≈ 1.2).

**Todavía no:** `float`, `height`, sombras `inset`, `skew`/`matrix`, desplazamientos en `%`,
selectores `@page :first`/`:left`, imágenes de fondo.

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
