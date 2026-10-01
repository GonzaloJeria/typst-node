import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startDevServer } from "./dev.js";
import { scaffoldFiles } from "./scaffold.js";
import { toStore, type TemplateSource, type TemplateStore } from "./sources.js";
import { createTemplates, type TemplatesOptions } from "./templates.js";

const HELP = `typst-pdf: templates HTML → PDF (Handlebars + Tailwind + Typst)

Uso:
  typst-pdf new <nombre> [--plain]        crea templates/<nombre> con un ejemplo (Tailwind; --plain: CSS simple)
  typst-pdf dev [--port 3333]             vista previa en vivo: PDF, navegador, warnings y datos
  typst-pdf render <nombre> [--data datos.json] [--out archivo.pdf]
  typst-pdf check [--strict]              renderiza todos los templates con su data.json y lista los warnings

Opciones comunes:
  --dir <carpeta>      carpeta de templates (por defecto ./templates)
  --source <módulo>    módulo JS/TS que exporta por defecto la fuente de templates (p. ej. desde la base de datos):
                         export default { get: (nombre) => …, list: () => […] }
                       o un objeto con { source, helpers, partials, locale, currency, … } (opciones de createTemplates)
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string", default: "templates" },
      source: { type: "string" },
      port: { type: "string", default: "3333" },
      host: { type: "string", default: "127.0.0.1" },
      data: { type: "string" },
      out: { type: "string" },
      plain: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, name] = positionals;
  if (values.help || !command || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "new") {
    if (!name) return fail("Falta el nombre: typst-pdf new <nombre>");
    const folder = path.resolve(values.dir, name);
    if (existsSync(folder)) return fail(`Ya existe: ${path.relative(process.cwd(), folder)}`);
    for (const [file, content] of Object.entries(scaffoldFiles(name, !values.plain))) {
      const target = path.join(folder, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      console.log(`  creado  ${path.relative(process.cwd(), target)}`);
    }
    console.log(`\nListo. Míralo con:  npx typst-pdf dev${values.dir === "templates" ? "" : ` --dir ${values.dir}`}`);
    if (!values.plain) console.log("(requiere: npm i tailwindcss @tailwindcss/node)");
    return 0;
  }

  const options = await loadOptions(values.source, values.dir);
  const templates = createTemplates(options);
  try {
    switch (command) {
      case "dev": {
        await templates.warmup();
        const server = await startDevServer({
          templates,
          port: Number(values.port),
          host: values.host,
          ...(values.source ? {} : { watch: path.resolve(values.dir) }),
        });
        console.log(`Vista previa en ${server.url}  (Ctrl+C para salir)`);
        await new Promise<void>((resolve) => process.once("SIGINT", resolve).once("SIGTERM", resolve));
        await server.close();
        return 0;
      }
      case "render": {
        if (!name) return fail("Falta el nombre: typst-pdf render <nombre>");
        const data = values.data ? JSON.parse(await readFile(values.data, "utf8")) : undefined;
        const result = await templates.render(name, data);
        const out = values.out ?? `${path.basename(name)}.pdf`;
        await writeFile(out, result.pdf);
        for (const w of result.warnings) console.warn(`  ⚠ ${w}`);
        console.log(`${out} (${(result.pdf.length / 1024).toFixed(1)} KB)`);
        return 0;
      }
      case "check": {
        const names = await templates.list();
        if (!names.length) return fail("No hay templates para revisar");
        let failed = 0;
        for (const n of names) {
          try {
            const started = performance.now();
            const r = await templates.render(n);
            const ms = Math.round(performance.now() - started);
            const all = [...r.warnings, ...r.diagnostics.map((d) => d.message)];
            // Missing fonts earlier in a CSS font stack are normal: informative only.
            const info = all.filter((w) => w.startsWith("fonts not available"));
            const issues = all.filter((w) => !info.includes(w));
            console.log(`${issues.length ? "⚠" : "✓"} ${n}  (${ms} ms)`);
            for (const w of issues) console.log(`    ${w}`);
            for (const w of info) console.log(`    ℹ ${w}`);
            if (issues.length && values.strict) failed++;
          } catch (err) {
            failed++;
            console.log(`✗ ${n}\n    ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return failed ? 1 : 0;
      }
      default:
        return fail(`Comando desconocido: ${command}\n\n${HELP}`);
    }
  } finally {
    await templates.dispose();
  }
}

/** Options from `--source` (a module) or the templates folder. */
async function loadOptions(source: string | undefined, dir: string): Promise<TemplatesOptions> {
  if (!source) return { source: dir };
  const mod = (await import(pathToFileURL(path.resolve(source)).href)) as { default?: unknown };
  const value = mod.default ?? mod;
  if (typeof value === "function" || (value && typeof value === "object" && "get" in value)) return { source: toStore(value as TemplateSource) as TemplateStore };
  if (value && typeof value === "object" && "source" in value) return value as TemplatesOptions;
  throw new Error(`${source} debe exportar por defecto una fuente ({ get, list }) o las opciones de createTemplates()`);
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
