import { afterAll, describe, expect, it } from "vitest";
import { PdfRenderer, pageWidth, tailwindCss } from "../src/index.js";

describe("tailwindCss (bundled)", () => {
  it("generates CSS only for the classes used", async () => {
    const { css, warnings } = await tailwindCss(`<p class="p-4 text-blue-600 md:flex">x</p>`);
    expect(warnings).toEqual([]);
    expect(css).toContain(".p-4");
    expect(css).toContain(".text-blue-600");
    expect(css).toContain(".md\\:flex");
    expect(css).not.toContain(".text-red-500");
  });

  it("uses the PDF's fonts for font-sans", async () => {
    const { css } = await tailwindCss(`<p class="font-sans">x</p>`);
    expect(css).toMatch(/--font-sans: sans-serif/);
    expect(css).not.toMatch(/--font-sans:[^;]*Segoe/);
  });

  it("supports @theme, @apply and @utility", async () => {
    const { css, warnings } = await tailwindCss(
      `<p class="text-marca boton tarjeta">x</p>`,
      "@theme { --color-marca: #0f766e } .boton { @apply rounded px-2 } @utility tarjeta { padding: 1rem }",
    );
    expect(warnings).toEqual([]);
    expect(css).toContain("--color-marca: #0f766e");
    expect(css).toMatch(/\.boton\s*{[^}]*padding-inline/);
    expect(css).toMatch(/\.tarjeta\s*{\s*padding: 1rem/);
  });

  it("warns about classes that do nothing on paper", async () => {
    const { warnings } = await tailwindCss(`<p class="txt-red-500 lg:grid-cols-3 max-lg:p-2 hover:underline dark:bg-black print:hidden">x</p>`);
    expect(warnings).toEqual([
      "Unknown class, no CSS generated: txt-red-500",
      "Breakpoints wider than the page (794px) never apply: lg:grid-cols-3 (lg: starts at 1024px; use md: or no prefix)",
      "hover: never applies in a PDF: hover:underline",
      "dark: never applies in a PDF: dark:bg-black",
    ]);
  });

  it("measures breakpoints against the page size", async () => {
    expect(pageWidth("@page { size: A4 landscape }")).toBe(1123);
    expect(pageWidth("@page { size: 300mm 200mm }")).toBeCloseTo(1133.9, 1);
    const { warnings } = await tailwindCss(`<p class="lg:flex">x</p>`, "@page { size: A3 landscape }");
    expect(warnings).toEqual([]);
  });

  it("explains unsupported plugins and imports", async () => {
    await expect(tailwindCss(`<p>x</p>`, `@import "tailwindcss"; @plugin "@tailwindcss/typography";`)).rejects.toThrow(/plugins and JS config are not supported/);
    await expect(tailwindCss(`<p>x</p>`, `@import "bootstrap";`)).rejects.toThrow(/Cannot @import "bootstrap"/);
  });
});

describe("render with tailwind: true", () => {
  const renderer = new PdfRenderer();
  afterAll(() => renderer.dispose());

  it("styles the HTML, including <style> blocks with @apply", async () => {
    const html = `<html><head><script src="https://cdn.tailwindcss.com"></script><style>.titulo { @apply text-2xl font-bold }</style></head>
      <body><h1 class="titulo text-red-600">Hola</h1><p class="mt-4 p-2 bg-zinc-100">x</p></body></html>`;
    const r = await renderer.render(html, { tailwind: true });
    expect(r.warnings).toEqual([]);
    expect(r.source).toContain('rgb("#e7000b")');
    expect(r.source).toContain("size: 18pt");
  });

  it("compiles each section with the layout CSS and its header/footer classes", async () => {
    const r = await renderer.render(
      {
        layout: { css: "@theme { --color-marca: #4f46e5 }", page: { footer: '<p class="text-marca text-xs">{{page}}</p>' } },
        sections: [{ html: '<h1 class="text-marca">A</h1>' }, { html: '<p class="font-bold">B</p>', css: "p { @apply italic }" }],
      },
      { tailwind: true },
    );
    expect(r.warnings).toEqual([]);
    expect(r.source).toContain('rgb("#4f46e5")');
    expect(r.source).toContain('style: "italic"');
  });

  it("leaves plain HTML alone without the option", async () => {
    const r = await renderer.render(`<h1 class="text-red-600">x</h1>`);
    expect(r.source).not.toContain("#e7000b");
    expect(r.source).toContain("size: 24pt");
  });
});
