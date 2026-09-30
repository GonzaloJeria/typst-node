// Latency and throughput over the visual fixtures, per backend.
// Run `pnpm build` first; the sidecar runs when TYPST_SIDECAR_PATH is set or
// crates/typst-sidecar has been built (`cargo build --release`).
import { existsSync, readFileSync } from "node:fs";
import { htmlToTypst } from "html-to-typst";
import { CliBackend, SidecarBackend } from "typst-compiler";
import { PdfRenderer } from "./dist/index.js";

const F = "test/fixtures/";
const files = ["escaping", "typography", "invoice", "modern", "tables", "report"];
const pct = (a, p) => a.sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
const sidecarPath = process.env.TYPST_SIDECAR_PATH ?? new URL("../../crates/typst-sidecar/target/release/typst-sidecar", import.meta.url).pathname;
const backends = { cli: (n) => new CliBackend({ maxConcurrency: n }) };
if (existsSync(sidecarPath)) backends.sidecar = (n) => new SidecarBackend({ binaryPath: sidecarPath, processes: n });

for (const [name, make] of Object.entries(backends)) {
  const backend = make(4);
  if (backend.warmup) await backend.warmup();
  const r = new PdfRenderer({ backend, defaults: { assets: { baseDir: F } } });
  console.log(`\n[${name}]\ndoc          pages  transpile_ms  total_p50_ms  total_p95_ms  pdf_kb`);
  for (const f of files) {
    const html = readFileSync(F + f + ".html", "utf8");
    const tr = [];
    for (let i = 0; i < 50; i++) { const t = performance.now(); htmlToTypst(html); tr.push(performance.now() - t); }
    const tot = []; let res;
    for (let i = 0; i < 30; i++) { const t = performance.now(); res = await r.render(html); tot.push(performance.now() - t); }
    const pages = (Buffer.from(res.pdf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    console.log(f.padEnd(12), String(pages).padStart(5), pct(tr, .5).toFixed(2).padStart(13), pct(tot, .5).toFixed(1).padStart(13), pct(tot, .95).toFixed(1).padStart(13), (res.pdf.length / 1024).toFixed(0).padStart(7));
  }
  await backend.dispose();

  for (const c of [1, 4]) {
    const b = make(c);
    if (b.warmup) await b.warmup();
    const rr = new PdfRenderer({ backend: b, defaults: { assets: { baseDir: F } } });
    const html = readFileSync(F + "invoice.html", "utf8");
    const n = 200, t = performance.now();
    await Promise.all(Array.from({ length: n }, () => rr.render(html)));
    const s = (performance.now() - t) / 1000;
    console.log(`throughput invoice, concurrency ${c}: ${(n / s).toFixed(1)} docs/s`);
    await b.dispose();
  }
}
const m = process.memoryUsage();
console.log(`\nnode rss ${(m.rss / 1048576).toFixed(0)} MB`);
