---
"@gjeria/typst-compiler": patch
"@gjeria/typst-html-pdf": patch
"@gjeria/pdf-templates": patch
---

Para producción:

- `maxQueue` en `SidecarBackend` y `CliBackend`: con la cola llena, `compile` rechaza al instante con `TypstQueueFullError` en vez de acumular documentos en memoria.
- `stats()` en los backends, `PdfRenderer` y `PdfTemplates`: capacidad, procesos vivos, en curso, en cola y totales (completados, fallidos, rechazados), para health checks y métricas.
- `timings` en cada resultado: `transpileMs`, `assetsMs`, `compileMs` y `totalMs`.
- Helper `date`: un día del calendario (`"2026-10-02"`, o un `Date` a medianoche UTC como los que guarda una base de datos) ya no se corre al día anterior según la zona horaria.
- Aviso cuando un template usa `{{number}}`, `{{date}}` u otro helper sin argumentos como si fuera un campo (no muestra nada).
