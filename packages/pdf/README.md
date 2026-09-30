# typst-html-pdf

HTML/CSS to PDF in Node.js **without Chromium**. HTML and CSS are transpiled to
[Typst](https://typst.app) and compiled by the official Typst engine: ~10 ms per
invoice, ~60 MB per worker, no headless browser.

```sh
npm install @gjeria/typst-html-pdf
```

That's it: the Typst engine comes with the package as a prebuilt binary for
Linux (x64/arm64, any distro including Alpine), macOS (x64/arm64) and Windows
(x64). No Chromium, no Typst install, no system packages.

On other platforms, or if optional dependencies were skipped, it falls back to
the official [`typst`](https://github.com/typst/typst/releases) CLI on the PATH.

## Usage

```ts
import { htmlToPdf } from "@gjeria/typst-html-pdf";

const { pdf, warnings } = await htmlToPdf(`
  <style>@page { size: A4; margin: 20mm } h1 { color: #4f46e5 }</style>
  <h1>Invoice 0042</h1><p>Thank you!</p>
`);
```

For a server, create one renderer at startup:

```ts
import { PdfRenderer } from "@gjeria/typst-html-pdf";

const renderer = new PdfRenderer({
  sidecar: { processes: 2, timeoutMs: 15_000, fonts: [{ dir: "/app/fonts" }] },
  defaults: {
    genericFamilies: { "sans-serif": ["Inter"] },
    assets: { baseDir: "/app/templates", allowRemote: true, allowedHosts: ["cdn.example.com"] },
  },
});
await renderer.warmup();

const { pdf } = await renderer.render({
  layout: {
    css: "body { font-family: sans-serif }",
    page: { size: "A4", margin: "22mm 18mm", header: '<img src="logo.svg">', footer: "Page {{page}} of {{pages}}" },
  },
  sections: [
    { html: coverHtml, css: coverCss, page: { margin: "0", header: false } },
    { html: termsHtml, css: "body { font-size: 8pt; columns: 2 }" },
  ],
});

process.on("SIGTERM", () => renderer.dispose());
```

`renderPages()` returns PNG or SVG pages for previews and visual tests.

## What is supported

Cascade, specificity, inheritance and CSS variables; colors, gradients,
opacity; borders, radius, shadows, transforms; `position` (absolute, relative,
fixed, running headers); tables with rowspan/colspan; flex rows and grids;
multi-column text; `height`/`min-height`; background images; `@page` size,
margins, backgrounds, margin boxes with page counters, named pages and `:first`;
`::before`/`::after`; lists; `line-height` and margins.

Unsupported CSS never disappears silently: every dropped declaration is listed
in `warnings`, and `strict: true` turns them into a `TranspileError`.

Images: data URIs, files inside `assets.baseDir`, and (opt-in) HTTP(S) with SSRF
protection (private IPs blocked at connect time, host allowlist, size and time
limits).

## License

MIT © Gonzalo Jeria
