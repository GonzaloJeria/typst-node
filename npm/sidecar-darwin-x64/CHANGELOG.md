# @typdf/sidecar-darwin-x64

## 0.3.0

### Minor Changes

- New name: the packages move to the `@typdf` npm organization.

  - `@gjeria/typst-html-pdf`, `@gjeria/pdf-templates` and `@gjeria/typst-compiler`
    are now one package, `@typdf/pdf`, with the same API: `PdfRenderer`,
    `htmlToPdf`, `createTemplates`, `memorySource`, `SidecarBackend`,
    `CliBackend`, the errors and the types all import from `@typdf/pdf`. The
    compiler's `PagesResult` type is exported as `CompilePagesResult`.
  - `@gjeria/html-to-typst` is now `@typdf/html-to-typst`.
  - The CLI is now `typdf` (`npx typdf dev`, `typdf check --strict`).
  - The prebuilt binaries are `@typdf/sidecar-<platform>-<arch>`, installed
    automatically.

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

## 0.1.3

## 0.1.2

## 0.1.1
