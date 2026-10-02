---
"@gjeria/typst-compiler": patch
"@gjeria/html-to-typst": patch
"@gjeria/typst-html-pdf": patch
"@gjeria/pdf-templates": patch
---

Menos tiempo y menos memoria en microservicios:

- Los elementos con la misma etiqueta, atributos y estilo de padre comparten su estilo calculado, como en los navegadores (filas y celdas de tabla). Una tabla de 300 filas con Tailwind convierte en ~60 ms en vez de ~140 ms (0.2.2) o ~300 ms (0.2.1). El resultado es idéntico byte a byte.
- `sidecar.idleTimeoutMs` (60 s por defecto): los procesos de Typst sin trabajo se detienen y devuelven su memoria; el siguiente documento los arranca de nuevo en ~50 ms.
- `transpileWorkers` (opcional, 0 por defecto): convierte el HTML en worker threads para no bloquear el event loop con documentos grandes.
- `stats()` incluye `transpileWorkers`.
