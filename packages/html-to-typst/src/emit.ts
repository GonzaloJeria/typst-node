import type { Block, Document, Inline, Size, TableCell, TableRow, TextStyle } from "./ir.js";
import { align, call, color, length, num, sides, size, str, stroke } from "./literals.js";

/**
 * IR → Typst source. The body is emitted entirely in code mode: every node is
 * a function call and every text run a string literal, so the output is
 * correct by construction regardless of what characters the HTML contained.
 */
export function emitDocument(doc: Document): string {
  const lines: string[] = [];
  if (doc.page) {
    const p = doc.page;
    lines.push(
      "#" +
        call("set page", {
          paper: p.paper === undefined ? undefined : str(p.paper),
          width: p.width && length(p.width),
          height: p.height && length(p.height),
          margin: p.margin && sides(p.margin, length),
        }),
    );
  }
  const text = { ...textArgs(doc.text ?? {}), lang: doc.lang === undefined ? undefined : str(doc.lang) };
  if (Object.values(text).some((v) => v !== undefined)) lines.push("#" + call("set text", text));
  lines.push(`#${seq(doc.children.map(emitBlock))}`);
  return lines.join("\n") + "\n";
}

/** Joins content values; a code block concatenates its expressions. */
function seq(items: string[]): string {
  if (items.length === 0) return "[]";
  if (items.length === 1) return items[0]!;
  return `{\n${items.map((i) => indent(i)).join("\n")}\n}`;
}

function indent(s: string): string {
  return s.replace(/^/gm, "  ");
}

function textArgs(s: TextStyle): Record<string, string | undefined> {
  return {
    font: s.font && `(${s.font.map(str).join(", ")}${s.font.length === 1 ? "," : ""})`,
    size: s.size && length(s.size),
    weight: s.weight === undefined ? undefined : typeof s.weight === "number" ? num(s.weight) : str(s.weight),
    style: s.style && str(s.style),
    fill: s.fill && color(s.fill),
    tracking: s.tracking && length(s.tracking),
  };
}

export function emitInline(node: Inline): string {
  switch (node.kind) {
    case "text":
      return str(node.value);
    case "strong":
    case "emph":
    case "underline":
    case "strike":
    case "super":
    case "sub":
      return `${node.kind}(${inlines(node.children)})`;
    case "code":
      return `raw(${str(node.value)})`;
    case "link":
      return `link(${str(node.href)}, ${inlines(node.children)})`;
    case "styled":
      return call("text", textArgs(node.style), inlines(node.children));
    case "linebreak":
      return "linebreak()";
    case "image":
      return call("box", {}, imageCall(node));
  }
}

function inlines(nodes: Inline[]): string {
  return seq(nodes.map(emitInline));
}

function blocks(nodes: Block[]): string {
  return seq(nodes.map(emitBlock));
}

function imageCall(n: { src: string; width?: Size; height?: Size; alt?: string }): string {
  return call(
    "image",
    {
      width: n.width && size(n.width),
      height: n.height && size(n.height),
      alt: n.alt === undefined ? undefined : str(n.alt),
    },
    str(n.src),
  );
}

export function emitBlock(node: Block): string {
  switch (node.kind) {
    case "paragraph": {
      const body = call("par", { justify: node.justify === undefined ? undefined : String(node.justify) }, inlines(node.children));
      return node.align ? `align(${align(node.align)}, ${body})` : body;
    }
    case "heading":
      return call("heading", { level: String(node.level) }, inlines(node.children));
    case "list": {
      const items = node.items.map(blocks);
      return node.ordered
        ? call("enum", { start: node.start === undefined ? undefined : num(node.start) }, ...items)
        : call("list", {}, ...items);
    }
    case "box": {
      const s = node.style;
      const b = call(
        "block",
        {
          width: s.width && size(s.width),
          inset: s.inset && sides(s.inset, length),
          fill: s.fill && color(s.fill),
          stroke: s.stroke && sides(s.stroke, stroke),
          radius: s.radius && length(s.radius),
          above: s.above && length(s.above),
          below: s.below && length(s.below),
          breakable: s.breakable === undefined ? undefined : String(s.breakable),
        },
        blocks(node.children),
      );
      return s.align ? `align(${align(s.align)}, ${b})` : b;
    }
    case "styled-block":
      return call("text", textArgs(node.style), blocks(node.children));
    case "table": {
      const parts: string[] = [];
      if (node.header?.length) parts.push(call("table.header", { repeat: "true" }, ...rows(node.header)));
      parts.push(...rows(node.body));
      if (node.footer?.length) parts.push(call("table.footer", {}, ...rows(node.footer)));
      return call(
        "table",
        {
          columns: `(${node.columns.map(size).join(", ")}${node.columns.length === 1 ? "," : ""})`,
          stroke: node.stroke === undefined ? undefined : node.stroke === null ? "none" : stroke(node.stroke),
          inset: node.inset && length(node.inset),
        },
        ...parts,
      );
    }
    case "grid":
      return call(
        "grid",
        {
          columns: `(${node.columns.map(size).join(", ")}${node.columns.length === 1 ? "," : ""})`,
          gutter: node.gutter && length(node.gutter),
        },
        ...node.cells.map(blocks),
      );
    case "raw-block":
      return call("raw", { block: "true", lang: node.lang === undefined ? undefined : str(node.lang) }, str(node.value));
    case "rule":
      return "line(length: 100%)";
    case "pagebreak":
      return call("pagebreak", { weak: node.weak ? "true" : undefined });
    case "image":
      return imageCall(node);
  }
}

function rows(rs: TableRow[]): string[] {
  return rs.flatMap((r) => r.cells.map(cell));
}

function cell(c: TableCell): string {
  const named = {
    colspan: c.colspan && c.colspan > 1 ? num(c.colspan) : undefined,
    rowspan: c.rowspan && c.rowspan > 1 ? num(c.rowspan) : undefined,
    align: c.align && align(c.align),
    fill: c.fill && color(c.fill),
  };
  const body = blocks(c.children);
  return Object.values(named).some((v) => v !== undefined) ? call("table.cell", named, body) : body;
}
