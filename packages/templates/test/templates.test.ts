import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinHelpers, createTemplates, fileSource, formatDate, memorySource, startDevServer, TemplateNotFoundError, type PdfTemplates } from "../src/index.js";

const call = (name: string, ...args: unknown[]) => (builtinHelpers()[name] as (...a: unknown[]) => unknown)(...args, { hash: {} });

describe("helpers", () => {
  it("formats money, numbers and percentages for es-CL", () => {
    expect(call("money", 1234567)).toBe("$1.234.567");
    expect(call("money", 10.5, "USD")).toBe("US$10,50");
    expect(call("number", 1234.5)).toBe("1.234,5");
    expect(call("number", 3, 2)).toBe("3,00");
    expect(call("percent", 0.1896)).toMatch(/^18,96\s?%$/);
  });

  it("formats dates with patterns and literal text", () => {
    expect(formatDate("2026-03-05", "dd/MM/yyyy")).toBe("05/03/2026");
    expect(formatDate("2026-03-05", "d 'de' MMMM 'de' yyyy")).toBe("5 de marzo de 2026");
    expect(call("date", "2026-12-24")).toBe("24-12-2026");
  });

  it("keeps calendar days on their day in any time zone", () => {
    const tz = { timeZone: "America/Santiago" };
    // A bare date and a date-only value from a database (UTC midnight).
    expect(formatDate("2026-10-02", "dd/MM/yyyy", tz)).toBe("02/10/2026");
    expect(formatDate(new Date("2026-10-02"), "dd/MM/yyyy", tz)).toBe("02/10/2026");
    expect(formatDate(new Date("2026-10-02"), "d 'de' MMMM", { timeZone: "Asia/Tokyo" })).toBe("2 de octubre");
    // A real instant still uses the time zone: 01:30 UTC is the evening before in Santiago.
    expect(formatDate(new Date("2026-10-02T01:30:00Z"), "dd/MM HH:mm", tz)).toBe("01/10 22:30");
  });

  it("does math and logic", () => {
    expect(call("sum", [{ t: 1 }, { t: 2.5 }], "t")).toBe(3.5);
    expect(call("mul", 3, 1000)).toBe(3000);
    expect(call("eq", "a", "a")).toBe(true);
    expect(call("default", "", "—")).toBe("—");
    expect(call("inc", 0)).toBe(1);
  });
});

describe("templates", () => {
  let dir: string;
  let templates: PdfTemplates;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pdf-templates-"));
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    };
    write("_partials/firma.html", "<p class='firma'>{{empresa}}</p>");
    write("factura/template.html", `<!doctype html><html><head>
      <link rel="preconnect" href="https://fonts.gstatic.com">
      <link rel="stylesheet" href="extra.css">
      <script src="https://cdn.tailwindcss.com"></script>
      <script>alert(1)</script>
      </head><body><h1 class="text-2xl font-bold text-marca">Factura {{numero}}</h1>
      {{#each items}}<p class="mt-2">{{nombre}}: {{money precio}}</p>{{/each}}{{> firma}}</body></html>`);
    write("factura/extra.css", ".firma { color: rgb(1 2 3) }");
    write("factura/style.css", "@theme { --color-marca: #4f46e5; }");
    write("factura/data.json", JSON.stringify({ numero: 7, empresa: "ACME", items: [{ nombre: "<b>Uno</b>", precio: 1000 }] }));
    write("informes/mensual/index.html", "<p>Informe</p>");
    write("informes/mensual/template.json", JSON.stringify({ page: { size: "A5", footer: "{{titulo}} · {{page}}/{{pages}}" } }));
    write("informes/mensual/data.json", JSON.stringify({ titulo: "Marzo" }));
    templates = createTemplates({ source: dir });
  });

  afterAll(async () => {
    await templates.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists template folders, nested ones included", async () => {
    expect(await templates.list()).toEqual(["factura", "informes/mensual"]);
  });

  it("runs Handlebars with escaping, partials and the sample data", async () => {
    const t = await templates.html("factura");
    expect(t.html).toContain("Factura 7");
    expect(t.html).toContain("&lt;b&gt;Uno&lt;/b&gt;: $1.000");
    expect(t.html).toContain("<p class='firma'>ACME</p>");
  });

  it("removes scripts, inlines local stylesheets and compiles Tailwind", async () => {
    const t = await templates.html("factura");
    expect(t.html).not.toContain("<script");
    expect(t.html).not.toContain("<link");
    expect(t.warnings).toEqual(["<script> was removed: JavaScript does not run when rendering a PDF"]);
    expect(t.css).toContain(".text-marca");
    expect(t.css).toContain("--color-marca: #4f46e5");
    expect(t.css).toContain(".firma");
  });

  it("renders a PDF", async () => {
    const r = await templates.render("factura", { numero: 8, empresa: "X", items: [] });
    expect(new TextDecoder().decode(r.pdf.slice(0, 5))).toBe("%PDF-");
    expect(r.html).toContain("Factura 8");
  });

  it("runs Handlebars on the footer but keeps the page counters", async () => {
    const t = await templates.html("informes/mensual");
    expect(t.page?.footer).toBe("Marzo · {{page}}/{{pages}}");
    const r = await templates.render("informes/mensual");
    expect(r.source).toContain("counter(page).display()");
  });

  it("renders templates from memory (e.g. a database row)", async () => {
    const db = createTemplates({ source: memorySource({ hola: { html: "<p class='text-red-600'>Hola {{nombre}}</p>", tailwind: true } }), renderer: templates.renderer });
    const r = await db.render("hola", { nombre: "Ana" });
    expect(r.html).toContain("Hola Ana");
    expect(r.css).toContain(".text-red-600");
    // Or pass the template itself, as loaded.
    const inline = await db.render({ html: "<p>{{x}}</p>" }, { x: 1 });
    expect(inline.html).toBe("<p>1</p>");
  });

  it("reports missing templates and Handlebars errors with the template name", async () => {
    await expect(templates.render("nope")).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(templates.render({ html: "{{#each x}}" })).rejects.toThrow(/Template \(inline\): Parse error/);
  });

  it("warns when a field is named like a helper", async () => {
    const t = await templates.html({ html: "<p>N° {{number}} · {{this.date}} · {{money total}}</p>" }, { number: "OC-1", date: "x", total: 1 });
    expect(t.html).toBe("<p>N°  · x · $1</p>");
    expect(t.warnings).toEqual([expect.stringContaining('{{number}} calls the "number" helper')]);
  });

  it("fails on missing data with strictData", async () => {
    const strict = createTemplates({ strictData: true, renderer: templates.renderer });
    await expect(strict.html({ html: "{{cliente.nombre}}" }, {})).rejects.toThrow(/not defined/);
  });

  it("serves the live preview", async () => {
    const server = await startDevServer({ templates, port: 0 });
    try {
      expect(await (await fetch(`${server.url}/api/templates`)).json()).toEqual(["factura", "informes/mensual"]);
      const post = (headers: Record<string, string>) => fetch(`${server.url}/api/render`, { method: "POST", headers, body: JSON.stringify({ name: "factura" }) });
      // A cross-site form post (not JSON) is refused.
      expect((await post({ "content-type": "text/plain" })).status).toBe(415);
      const r = (await (await post({ "content-type": "application/json" })).json()) as { id: string; warnings: string[] };
      const pdf = await fetch(`${server.url}/out/${r.id}.pdf`);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      const page = await fetch(`${server.url}/out/${r.id}.html`);
      expect(page.headers.get("content-security-policy")).toContain("script-src 'none'");
      const html = await page.text();
      expect(html).toContain('<base href="/assets/factura/">');
      const css = await fetch(`${server.url}/assets/factura/extra.css`);
      expect(await css.text()).toContain(".firma");
      expect((await fetch(`${server.url}/assets/factura/../_partials/firma.html`)).status).toBe(404);
      // DNS rebinding: another host name pointing at this server is refused.
      const { request } = await import("node:http");
      const status = await new Promise<number>((resolve, reject) => {
        const u = new URL(server.url);
        request({ host: u.hostname, port: u.port, path: "/api/templates", headers: { host: "evil.example:80" } }, (res) => resolve(res.statusCode!)).on("error", reject).end();
      });
      expect(status).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe("fileSource", () => {
  it("does not leave the templates folder", async () => {
    expect(await fileSource(tmpdir()).get("../etc")).toBeUndefined();
  });
});
