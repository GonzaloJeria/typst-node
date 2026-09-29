# typst-node

Generación de PDF en Node.js sin navegador: HTML/CSS → Typst → PDF.

| Paquete | Estado |
|---|---|
| [`typst-compiler`](packages/typst-compiler) | `TypstBackend` + `CliBackend` (binario oficial de Typst, cero dependencias de runtime) |
| [`html-to-typst`](packages/html-to-typst) | IR de layout + emisor Typst en modo código. Front-end HTML/CSS pendiente |

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
