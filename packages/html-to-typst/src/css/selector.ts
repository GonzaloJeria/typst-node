/**
 * Selector subset: type, `*`, `#id`, `.class`, `[attr]`, `[attr=v]`,
 * `[attr~=v]`, `[attr^=v]`, `[attr$=v]`, `[attr*=v]`, `:first-child`,
 * `:last-child`, `:nth-child(odd|even|N)`, descendant and `>` combinators.
 * Anything else makes the selector unsupported (never matches).
 */

export interface SelectorElement {
  tagName: string;
  getAttribute(name: string): string | undefined;
  parent(): SelectorElement | undefined;
  /** 1-based position among element siblings, and their count. */
  position(): { index: number; count: number };
}

type AttrOp = "" | "=" | "~=" | "^=" | "$=" | "*=";
interface Compound {
  tag?: string;
  ids: string[];
  classes: string[];
  attrs: { name: string; op: AttrOp; value: string }[];
  pseudos: ((el: SelectorElement) => boolean)[];
}
interface Part {
  compound: Compound;
  /** Combinator linking this compound to the previous (left) one. */
  combinator: " " | ">" | null;
}

export interface Selector {
  parts: Part[];
  specificity: [number, number, number];
}

const IDENT = String.raw`-?[_a-zA-Z -￿][-_a-zA-Z0-9 -￿]*`;
const TOKEN = new RegExp(
  String.raw`^(?:(\*)|(${IDENT})|#(${IDENT})|\.(${IDENT})|\[\s*(${IDENT})\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]|:(${IDENT})(?:\(\s*([^)]*)\s*\))?)`,
);

export function parseSelector(text: string): Selector | undefined {
  const parts: Part[] = [];
  let rest = text.trim();
  let combinator: Part["combinator"] = null;
  let spec: [number, number, number] = [0, 0, 0];

  while (rest.length > 0) {
    const compound: Compound = { ids: [], classes: [], attrs: [], pseudos: [] };
    let consumed = false;
    for (let m = TOKEN.exec(rest); m; m = TOKEN.exec(rest)) {
      consumed = true;
      rest = rest.slice(m[0].length);
      if (m[1]) continue;
      if (m[2]) {
        compound.tag = m[2].toLowerCase();
        spec[2]++;
      } else if (m[3]) {
        compound.ids.push(m[3]);
        spec[0]++;
      } else if (m[4]) {
        compound.classes.push(m[4]);
        spec[1]++;
      } else if (m[5]) {
        compound.attrs.push({ name: m[5].toLowerCase(), op: (m[6] ?? "") as AttrOp, value: m[7] ?? m[8] ?? m[9] ?? "" });
        spec[1]++;
      } else if (m[10]) {
        const pseudo = parsePseudo(m[10].toLowerCase(), m[11]);
        if (!pseudo) return undefined;
        compound.pseudos.push(pseudo);
        spec[1]++;
      }
    }
    if (!consumed) return undefined;
    parts.push({ compound, combinator });

    const comb = /^\s*([>+~])\s*|^\s+/.exec(rest);
    if (!comb) break;
    if (comb[1] === "+" || comb[1] === "~") return undefined;
    combinator = comb[1] === ">" ? ">" : " ";
    rest = rest.slice(comb[0].length);
  }
  if (rest.trim().length > 0 || parts.length === 0) return undefined;
  return { parts, specificity: spec };
}

function parsePseudo(name: string, arg: string | undefined): ((el: SelectorElement) => boolean) | undefined {
  switch (name) {
    case "first-child": return (el) => el.position().index === 1;
    case "last-child": return (el) => { const p = el.position(); return p.index === p.count; };
    case "nth-child": {
      const a = arg?.trim().toLowerCase();
      if (a === "odd") return (el) => el.position().index % 2 === 1;
      if (a === "even") return (el) => el.position().index % 2 === 0;
      if (a && /^\d+$/.test(a)) return (el) => el.position().index === Number(a);
      return undefined;
    }
    default: return undefined;
  }
}

export function matches(selector: Selector, el: SelectorElement): boolean {
  return matchFrom(selector.parts, selector.parts.length - 1, el);
}

function matchFrom(parts: Part[], i: number, el: SelectorElement): boolean {
  const part = parts[i]!;
  if (!matchCompound(part.compound, el)) return false;
  if (i === 0) return true;
  if (part.combinator === ">") {
    const p = el.parent();
    return p !== undefined && matchFrom(parts, i - 1, p);
  }
  for (let p = el.parent(); p; p = p.parent()) {
    if (matchFrom(parts, i - 1, p)) return true;
  }
  return false;
}

function matchCompound(c: Compound, el: SelectorElement): boolean {
  if (c.tag && c.tag !== el.tagName) return false;
  if (c.ids.length && c.ids.some((id) => el.getAttribute("id") !== id)) return false;
  if (c.classes.length) {
    const cls = (el.getAttribute("class") ?? "").split(/\s+/);
    if (!c.classes.every((x) => cls.includes(x))) return false;
  }
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === undefined) return false;
    switch (a.op) {
      case "=": if (v !== a.value) return false; break;
      case "~=": if (!v.split(/\s+/).includes(a.value)) return false; break;
      case "^=": if (!a.value || !v.startsWith(a.value)) return false; break;
      case "$=": if (!a.value || !v.endsWith(a.value)) return false; break;
      case "*=": if (!a.value || !v.includes(a.value)) return false; break;
    }
  }
  return c.pseudos.every((p) => p(el));
}
