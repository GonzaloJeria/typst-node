import { describe, expect, it } from "vitest";
import { composeToTypst, htmlToTypst, TranspileError } from "../src/index.js";

describe("named pages", () => {
  const css = `
    @page { margin: 20mm; @top-center { content: "Doc" } }
    @page legal { margin: 10mm; @top-center { content: none } }
    .legal { page: legal }`;

  it("groups adjacent elements with the same page name into one run", () => {
    const r = htmlToTypst(`<p>a</p><div class="legal">b</div><div class="legal">c</div><p>d</p>`, { css });
    expect(r.warnings).toEqual([]);
    const kinds = r.document.children.map((b) => b.kind);
    expect(kinds).toEqual(["paragraph", "page-run", "paragraph"]);
    const run = r.document.children[1]!;
    expect(run.kind === "page-run" && run.children).toHaveLength(2);
    expect(r.source).toContain("set page(margin: 10mm");
    expect(r.source).toContain("header: none");
  });

  it("keeps an unknown page name as a page break", () => {
    const r = htmlToTypst(`<p>a</p><p style="page: other">b</p>`);
    expect(r.document.children[1]).toMatchObject({ kind: "page-run", name: "other" });
    expect(r.source).toContain("pagebreak(weak: true)");
  });

  it("unwraps named pages inside styled containers with a warning", () => {
    const r = htmlToTypst(`<div style="border: 1px solid red"><p class="legal">x</p></div>`, { css });
    expect(JSON.stringify(r.document)).not.toContain("page-run");
    expect(r.warnings.some((w) => w.includes("page: legal ignored"))).toBe(true);
  });

  it("supports @page :first backgrounds and margin boxes", () => {
    const r = htmlToTypst(`<p>x</p>`, {
      css: `@page { @top-center { content: "Doc" } } @page :first { background: #eee; @top-center { content: none } }`,
    });
    expect(r.warnings).toEqual([]);
    expect(r.document.page?.first).toEqual({ fill: "#eeeeee", header: null });
    expect(r.source).toContain("context if here().page() == 1 { none } else {");
  });

  it("supports counter(page) in generated content", () => {
    const r = htmlToTypst(`<span class="n"></span>`, { css: `.n::before { content: "p. " counter(page) }` });
    expect(r.warnings).toEqual([]);
    expect(r.source).toContain("context counter(page).display()");
  });
});

describe("composeToTypst", () => {
  const input = {
    layout: { css: "p { color: blue }", page: { size: "A5", header: "<b>ACME</b>", footer: "{{page}}/{{pages}}" } },
    sections: [
      { html: "<p class=x>cover</p>", css: ".x { color: red }", page: { margin: "0", header: false as const, footer: false as const } },
      { html: "<p class=x>terms</p>" },
    ],
  };

  it("builds one page run per section with scoped CSS", () => {
    const r = composeToTypst(input);
    expect(r.warnings).toEqual([]);
    const [a, b] = r.document.children;
    expect(a).toMatchObject({ kind: "page-run", page: { paper: "a5", margin: { top: { value: 0 } } } });
    expect(a?.kind === "page-run" && a.page?.header).toBeUndefined();
    expect(JSON.stringify(a)).toContain("#ff0000");
    // Section CSS does not leak into later sections; layout CSS applies to all.
    expect(JSON.stringify(b)).not.toContain("#ff0000");
    expect(JSON.stringify(b)).toContain("#0000ff");
    expect(b?.kind === "page-run" && b.page?.header).toBeTruthy();
    expect(r.source).toContain("context str(counter(page).final().first())");
  });

  it("labels warnings by section and honours strict", () => {
    const bad = { sections: [{ html: "<p>ok</p>" }, { html: `<p style="float: left">x</p>` }] };
    expect(composeToTypst(bad).warnings[0]).toMatch(/^\[section 2\] /);
    expect(() => composeToTypst(bad, { strict: true })).toThrow(TranspileError);
  });
});
