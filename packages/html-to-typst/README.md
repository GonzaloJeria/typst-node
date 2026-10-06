# html-to-typst

Transpiles HTML and CSS to [Typst](https://typst.app) source, with its own CSS
engine (cascade, specificity, inheritance, variables, `calc()`, paged media).
Used by [`@typdf/pdf`](https://www.npmjs.com/package/@typdf/pdf); use it
directly to inspect or post-process the generated Typst.

```ts
import { htmlToTypst, composeToTypst } from "@typdf/html-to-typst";

const { source, warnings, assets } = htmlToTypst(html, { css: extraCss, strict: false });
// `source` is Typst; `assets` lists the images to provide as files to the compiler.
```

Every text run is emitted as a Typst string literal, so no HTML input can
inject Typst code. Everything that cannot be rendered is reported in `warnings`.

MIT © Gonzalo Jeria
