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

  it("implements min-height with a strut column", () => {
    const r = box(`<div style="min-height: 3cm; background: #eee">x</div>`);
    expect(r.warnings).toEqual([]);
    expect(r.source).toContain("grid(columns: (0pt, 1fr), block(height: 3cm)");
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
