import { describe, expect, it } from "vitest";
import { htmlToTypst } from "../src/index.js";

const box = (html: string, css = "") => {
  const r = htmlToTypst(html, { css });
  const b = r.document.children[0];
  if (b?.kind !== "box") throw new Error(`expected a box, got ${b?.kind}`);
  return { ...r, style: b.style };
};

describe("heights", () => {
  it("adds padding to content-box heights, as CSS does", () => {
    const r = box(`<div style="height: 50mm; padding: 10pt">x</div>`);
    expect(r.warnings).toEqual([]);
    expect(r.style.height).toEqual({ value: 50, unit: "mm" });
    expect(r.source).toContain("height: 50mm + 10pt + 10pt");
  });

  it("keeps border-box heights as given", () => {
    const r = box(`<div style="box-sizing: border-box; height: 100%; padding: 10pt">x</div>`);
    expect(r.source).toContain("height: 100%,");
  });

  it("gives a min-height box a definite height when its content fits", () => {
    const r = box(`<div style="min-height: 3cm; background: #eee">x</div>`);
    expect(r.warnings).toEqual([]);
    expect(r.source).toContain("let h = if h < 3cm { 3cm } else { auto }");
    expect(r.source).toContain("height: h");
  });
});

describe("background images", () => {
  it("parses the shorthand and collects the asset", () => {
    const r = box(`<div style="background: #111 url('img/hero.jpg') center / cover no-repeat; padding: 1cm">x</div>`);
    expect(r.warnings).toEqual([]);
    expect(r.style.fill).toBe("#111111");
    expect(r.style.image).toEqual({ src: "img/hero.jpg", fit: "cover", align: { x: "center", y: "horizon" } });
    expect(r.assets).toEqual(["img/hero.jpg"]);
    expect(r.source).toContain('image(width: 100%, height: 100%, fit: "cover", "img/hero.jpg")');
    expect(r.source).toContain("clip: true");
  });

  it("supports explicit sizes and positions", () => {
    const r = box(`<div class="c">x</div>`, `.c { background-image: url(logo.png); background-size: 2cm; background-position: right bottom; background-repeat: no-repeat }`);
    expect(r.warnings).toEqual([]);
    expect(r.style.image).toEqual({ src: "logo.png", fit: { width: { value: 2, unit: "cm" } }, align: { x: "right", y: "bottom" } });
  });

  it("stretches with 100% 100%", () => {
    const r = box(`<div style="background-image: url(a.png); background-size: 100% 100%">x</div>`);
    expect(r.style.image?.fit).toBe("stretch");
  });
});

describe("multi-column", () => {
  it("maps column-count and the columns shorthand", () => {
    const a = htmlToTypst(`<div style="column-count: 3; column-gap: 5mm"><p>x</p></div>`);
    expect(a.warnings).toEqual([]);
    expect(a.document.children[0]).toMatchObject({ kind: "columns", count: 3, gutter: { value: 5, unit: "mm" } });
    expect(a.source).toContain("columns(3, gutter: 5mm, body)");
    const b = htmlToTypst(`<div style="columns: 2"><p>x</p></div>`);
    expect(b.document.children[0]).toMatchObject({ kind: "columns", count: 2, gutter: { value: 1, unit: "em" } });
  });

  it("warns about column widths it cannot honour", () => {
    const r = htmlToTypst(`<div style="columns: 2 10em"><p>x</p></div>`);
    expect(r.warnings.some((w) => w.includes("column-width"))).toBe(true);
  });
});

describe("@page background images", () => {
  it("paints the image behind every page and collects the asset", () => {
    const r = htmlToTypst(`<p>x</p>`, { css: `@page { background: #fafafa url(bg.svg) center / cover no-repeat }` });
    expect(r.warnings).toEqual([]);
    expect(r.document.page).toMatchObject({ fill: "#fafafa", image: { src: "bg.svg", fit: "cover" } });
    expect(r.assets).toEqual(["bg.svg"]);
    expect(r.source).toContain('background: block(width: 100%, height: 100%, align(center + horizon, image(width: 100%, height: 100%, fit: "cover", "bg.svg")))');
  });

  it("warns about repeated page backgrounds", () => {
    const r = htmlToTypst(`<p>x</p>`, { css: `@page { background: url(bg.svg) repeat }` });
    expect(r.warnings.some((w) => w.startsWith("Unsupported @page background"))).toBe(true);
  });
});
