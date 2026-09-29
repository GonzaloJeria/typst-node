import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { emitDocument, emitInline, typstString, type Document } from "../src/index.js";

const binary = process.env.TYPST_PATH ?? "typst";
const hasTypst = spawnSync(binary, ["--version"]).status === 0;

/** Throws with the compiler diagnostics if the source does not compile. */
function compileOk(source: string): void {
  const r = spawnSync(binary, ["compile", "--diagnostic-format", "short", "-", "-"], { input: source });
  if (r.status !== 0) throw new Error(`${r.stderr.toString()}\n--- source ---\n${source}`);
}

/** Evaluates a Typst expression with the official binary and decodes the JSON result. */
function typstEval(expr: string): string {
  return JSON.parse(execFileSync(binary, ["eval", expr]).toString()) as string;
}

const invoice: Document = {
  page: { paper: "a4", margin: { top: { value: 2, unit: "cm" }, right: { value: 2, unit: "cm" }, bottom: { value: 2, unit: "cm" }, left: { value: 2, unit: "cm" } } },
  text: { font: ["Libertinus Serif"], size: { value: 10, unit: "pt" } },
  lang: "es",
  children: [
    { kind: "heading", level: 1, children: [{ kind: "text", value: "Factura #001" }] },
    {
      kind: "paragraph",
      align: "right",
      children: [
        { kind: "text", value: "Total: " },
        { kind: "strong", children: [{ kind: "text", value: "$ 1.200 *IVA*" }] },
        { kind: "linebreak" },
        { kind: "link", href: "https://example.com", children: [{ kind: "text", value: "@example" }] },
      ],
    },
    {
      kind: "table",
      columns: [{ value: 1, unit: "fr" }, "auto", "auto"],
      header: [{ cells: [{ children: [{ kind: "paragraph", children: [{ kind: "strong", children: [{ kind: "text", value: "Ítem" }] }] }], colspan: 2 }, { children: [] }] }],
      body: [
        { cells: [{ children: [{ kind: "paragraph", children: [{ kind: "text", value: "A" }] }], rowspan: 2 }, { children: [] }, { children: [], fill: "#eeeeee", align: "right" }] },
        { cells: [{ children: [] }, { children: [] }] },
      ],
    },
    { kind: "box", style: { breakable: false, inset: { top: { value: 4, unit: "pt" } }, fill: "#fafafa", align: "center" }, children: [
      { kind: "list", ordered: true, start: 3, items: [[{ kind: "paragraph", children: [{ kind: "text", value: "uno" }] }], []] },
    ] },
    { kind: "pagebreak", weak: true },
    { kind: "raw-block", lang: "ts", value: 'const a = "b";\n' },
    { kind: "rule" },
  ],
};

describe("emitDocument", () => {
  it("emits code-mode Typst", () => {
    expect(emitDocument(invoice)).toMatchSnapshot();
  });

  it.skipIf(!hasTypst)("produces source the official compiler accepts", () => {
    compileOk(emitDocument(invoice));
  });
});

const NASTY = [
  "#set page(width: 1pt)",
  "$x^2$ *bold* _em_ `raw` @ref <label> = heading",
  'quotes " and \\ backslashes \\" end\\',
  "]) } ) ] // not a comment /* nor this */",
  "tab\there\nnewline\r\u0001ctrl\u007f",
  "emoji 🧾 ñ 中文 ​",
];

describe("string literals", () => {
  it.skipIf(!hasTypst).each(NASTY)("round-trips %j exactly", (value) => {
    expect(typstEval(typstString(value))).toBe(value);
  });

  it.skipIf(!hasTypst)("keeps markup characters inert inside documents", () => {
    compileOk(
      emitDocument({ children: NASTY.map((v) => ({ kind: "paragraph", children: [{ kind: "text", value: v }] })) }),
    );
  });

  it("emits inline nodes as calls", () => {
    expect(emitInline({ kind: "emph", children: [{ kind: "text", value: "a" }, { kind: "code", value: "b" }] })).toBe(
      'emph({\n  "a"\n  raw("b")\n})',
    );
  });
});
