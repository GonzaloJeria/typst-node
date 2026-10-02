#!/usr/bin/env node
/**
 * Release smoke test: packs every publishable package as npm would publish
 * it, installs the tarballs into an empty project, and exercises the public
 * entry points from outside the monorepo (ESM, CommonJS, the CLI, Tailwind,
 * the sidecar binary of this platform).
 *
 *   pnpm build && node scripts/smoke-pack.mjs
 *
 * Needs the sidecar binary for this platform in npm/ (pnpm sidecar:build or
 * a release build); without it the renderer falls back to the `typst` CLI.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const work = mkdtempSync(path.join(tmpdir(), "typst-node-smoke-"));
const packs = path.join(work, "packs");
const app = path.join(work, "app");
mkdirSync(packs);
mkdirSync(app);
const isWin = process.platform === "win32";
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell: isWin });

const dirs = [
  ...readdirSync(path.join(ROOT, "packages")).map((d) => path.join(ROOT, "packages", d)),
  ...readdirSync(path.join(ROOT, "npm")).map((d) => path.join(ROOT, "npm", d)),
];
const tarballs = {};
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  if (pkg.private) continue;
  // Platform packages for other systems cannot be installed here; skip their binaries.
  if (pkg.os && !pkg.os.includes(process.platform)) continue;
  if (pkg.cpu && !pkg.cpu.includes(process.arch)) continue;
  if (pkg.bin && pkg.name.includes("typst-sidecar-") && !Object.values(pkg.bin ?? {}).every((b) => existsSync(path.join(dir, b)))) continue;
  const out = run("pnpm", ["pack", "--pack-destination", packs], dir).trim().split("\n").at(-1);
  tarballs[pkg.name] = `file:${path.isAbsolute(out) ? out : path.join(packs, path.basename(out))}`;
}
console.log(`packed ${Object.keys(tarballs).length} packages`);

writeFileSync(
  path.join(app, "package.json"),
  JSON.stringify(
    {
      name: "smoke",
      private: true,
      dependencies: { "@gjeria/pdf-templates": tarballs["@gjeria/pdf-templates"], "@gjeria/typst-html-pdf": tarballs["@gjeria/typst-html-pdf"] },
      // Every @gjeria dependency resolves to the local tarball, not the registry.
      overrides: tarballs,
    },
    null,
    2,
  ),
);
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], app);

const check = (name, ok) => {
  if (!ok) throw new Error(`smoke test failed: ${name}`);
  console.log(`✓ ${name}`);
};

// ESM: templates with Tailwind and the base renderer.
writeFileSync(
  path.join(app, "esm.mjs"),
  `import { createTemplates } from "@gjeria/pdf-templates";
import { htmlToPdf, disposeDefaultRenderer } from "@gjeria/typst-html-pdf";
const t = createTemplates();
const r = await t.render({ html: '<h1 class="text-2xl font-bold text-indigo-600">{{titulo}}</h1><p class="lg:p-4">x</p>' }, { titulo: "Hola" });
const base = await htmlToPdf('<p class="p-4 bg-zinc-100">x</p>', { tailwind: true });
const { PdfRenderer } = await import("@gjeria/typst-html-pdf");
const threaded = new PdfRenderer({ transpileWorkers: 1 });
const w = await threaded.render('<p class="p-4">x</p>', { tailwind: true });
const workers = threaded.stats()?.transpileWorkers;
await threaded.dispose();
console.log(JSON.stringify({ pdf: Buffer.from(r.pdf.slice(0, 5)).toString(), tw: r.css.includes(".text-indigo-600"), warn: r.warnings.length, base: base.pdf.length > 0, worker: w.pdf.length > 0 && workers === 1 }));
await t.dispose();
await disposeDefaultRenderer();
`,
);
const esm = JSON.parse(run("node", ["esm.mjs"], app));
check("ESM import, Handlebars, bundled Tailwind, PDF output", esm.pdf === "%PDF-" && esm.tw && esm.base);
check("Tailwind warnings reach the result", esm.warn === 1);
check("ESM transpile worker thread", esm.worker);

// CommonJS.
writeFileSync(
  path.join(app, "cjs.cjs"),
  `const { PdfRenderer } = require("@gjeria/typst-html-pdf");
const { createTemplates } = require("@gjeria/pdf-templates");
(async () => {
  const renderer = new PdfRenderer({ transpileWorkers: 1 });
  const r = await renderer.render('<p class="text-red-600">x</p>', { tailwind: true });
  const worker = renderer.stats()?.transpileWorkers === 1;
  const t = createTemplates({ renderer });
  const h = await t.html({ html: "<p>{{money 1000}}</p>" });
  console.log(JSON.stringify({ ok: r.pdf.length > 1000, money: h.html, backend: renderer.backend.constructor.name, worker }));
  await renderer.dispose();
})();
`,
);
const cjs = JSON.parse(run("node", ["cjs.cjs"], app));
check("CommonJS require", cjs.ok && cjs.money === "<p>$1.000</p>");
check("CommonJS transpile worker thread", cjs.worker);
console.log(`  backend: ${cjs.backend}`);

// CLI.
const bin = path.join(app, "node_modules", ".bin", isWin ? "typst-pdf.cmd" : "typst-pdf");
run(bin, ["new", "factura"], app);
run(bin, ["render", "factura", "--out", "factura.pdf"], app);
check("CLI new + render", readFileSync(path.join(app, "factura.pdf")).subarray(0, 5).toString() === "%PDF-");
const report = run(bin, ["check", "--strict"], app);
check("CLI check --strict on the scaffold", report.includes("✓ factura"));

rmSync(work, { recursive: true, force: true });
console.log("smoke test passed");
