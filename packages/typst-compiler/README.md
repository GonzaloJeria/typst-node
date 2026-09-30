# typst-compiler

Compile [Typst](https://typst.app) to PDF, PNG or SVG from Node.js. No runtime
dependencies; two interchangeable backends:

- `CliBackend`: runs the official `typst` binary once per document.
- `SidecarBackend`: keeps [`typst-sidecar`](https://github.com/GonzaloJeria/typst-node/tree/main/crates/typst-sidecar)
  processes alive between documents (several times faster).

```ts
import { SidecarBackend } from "typst-compiler";

const typst = new SidecarBackend({ processes: 4, timeoutMs: 10_000 });
const { pdf, warnings } = await typst.compile({
  source: '#image("logo.png", width: 3cm)\n= Hello #sys.inputs.name',
  files: new Map([["logo.png", logoBytes]]),
  inputs: { name: "Ada" },
});
await typst.dispose();
```

Both backends support virtual files, extra fonts, `sys.inputs`, timeouts,
`AbortSignal`, bounded concurrency and structured diagnostics.

MIT © Gonzalo Jeria
