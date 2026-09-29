/** Minimal CSS parser: style rules, `@page`, and `@media print`. */

export interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

export interface StyleRule {
  selectors: string[];
  declarations: Declaration[];
}

export interface Stylesheet {
  rules: StyleRule[];
  page: Declaration[];
}

export function parseDeclarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  for (const part of splitTopLevel(text, ";")) {
    const i = part.indexOf(":");
    if (i === -1) continue;
    const property = part.slice(0, i).trim().toLowerCase();
    let value = part.slice(i + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    if (property && value) out.push({ property, value, important });
  }
  return out;
}

export function parseStylesheet(css: string, into: Stylesheet = { rules: [], page: [] }): Stylesheet {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open === -1) break;
    // Statement at-rules (`@import …;`, `@charset …;`) have no block.
    const semi = src.indexOf(";", i);
    if (src.slice(i).trimStart().startsWith("@") && semi !== -1 && semi < open) {
      i = semi + 1;
      continue;
    }
    const prelude = src.slice(i, open).trim();
    const close = matchingBrace(src, open);
    const body = src.slice(open + 1, close);
    i = close + 1;

    if (prelude.startsWith("@")) {
      const at = prelude.toLowerCase();
      if (at.startsWith("@page")) into.page.push(...parseDeclarations(body));
      else if (at.startsWith("@media") && /\bprint\b/.test(at) && !/\bnot\b/.test(at)) parseStylesheet(body, into);
      // Other at-rules (@font-face, @import, screen media, …) are ignored.
      continue;
    }
    const selectors = splitTopLevel(prelude, ",").map((s) => s.trim()).filter(Boolean);
    if (selectors.length > 0) into.rules.push({ selectors, declarations: parseDeclarations(body) });
  }
  return into;
}

function matchingBrace(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return j;
  }
  return src.length;
}

/** Splits on `sep` outside parentheses and quotes. */
export function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
