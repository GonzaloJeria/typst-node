// Latency and throughput over the visual fixtures. Run `pnpm build` first.
import { readFileSync } from "node:fs";
import { htmlToTypst } from "html-to-typst";
import { PdfRenderer } from "./dist/index.js";

const F = "test/fixtures/";
const files = ["escaping", "typography", "invoice", "modern", "tables", "report"];
const r = new PdfRenderer({ cli: { maxConcurrency: 4 }, defaults: { assets: { baseDir: F } } });
const pct = (a, p) => a.sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];

console.log("doc          pages  transpile_ms  total_p50_ms  total_p95_ms  pdf_kb");
for (const f of files) {
  const html = readFileSync(F + f + ".html", "utf8");
  const tr = [];
  for (let i = 0; i < 50; i++) { const t = performance.now(); htmlToTypst(html); tr.push(performance.now() - t); }
  const tot = []; let res;
  for (let i = 0; i < 15; i++) { const t = performance.now(); res = await r.render(html); tot.push(performance.now() - t); }
  const pages = (Buffer.from(res.pdf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log(f.padEnd(12), String(pages).padStart(5), pct(tr, .5).toFixed(2).padStart(13), pct(tot, .5).toFixed(0).padStart(13), pct(tot, .95).toFixed(0).padStart(13), (res.pdf.length / 1024).toFixed(0).padStart(7));
}

for (const c of [1, 4]) {
  const rr = new PdfRenderer({ cli: { maxConcurrency: c }, defaults: { assets: { baseDir: F } } });
  const html = readFileSync(F + "invoice.html", "utf8");
  const n = 40, t = performance.now();
  await Promise.all(Array.from({ length: n }, () => rr.render(html)));
  const s = (performance.now() - t) / 1000;
  console.log(`throughput invoice, concurrency ${c}: ${(n / s).toFixed(1)} docs/s`);
  await rr.dispose();
}
const m = process.memoryUsage();
console.log(`node rss ${(m.rss / 1048576).toFixed(0)} MB`);
await r.dispose();
