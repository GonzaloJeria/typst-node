/**
 * Selectors Level 4 for a static document: type, `*`, `#id`, `.class`,
 * attribute selectors (with `i`/`s` flags), all four combinators, structural
 * pseudo-classes (`:nth-child(An+B of S)`, `:*-of-type`, `:only-child`,
 * `:empty`, `:root`), logical ones (`:is`, `:where`, `:not`, `:has`), and
 * pseudo-elements. Identifiers may use CSS escapes (`.md\:flex`, `.w-1\/2`).
 *
 * Interactive states (`:hover`, `:focus`, `:checked`…) never match on paper.
 * Unknown pseudo-classes make the selector unsupported (never matches).
 */

export interface SelectorElement {
  tagName: string;
  getAttribute(name: string): string | undefined;
  parent(): SelectorElement | undefined;
  /** 1-based position among element siblings, and their count. */
  position(): { index: number; count: number };
  /** Element siblings in document order, including this element. */
  siblings?(): SelectorElement[];
  /** Element children in document order. */
  children?(): SelectorElement[];
  /** True when the element has no element or text children. */
  isEmpty?(): boolean;
}

type Combinator = " " | ">" | "+" | "~";
type Test = (el: SelectorElement) => boolean;

interface Compound {
  tests: Test[];
  /** Cheapest required feature (`#id`, `.class` or tag name), for rule indexing. */
  key?: string;
}
interface Part {
  compound: Compound;
  /** Combinator linking this compound to the previous (left) one. */
  combinator: Combinator | null;
}

export type Specificity = [number, number, number];

export interface Selector {
  parts: Part[];
  /** Index key of the subject compound: `#id`, `.class`, a tag name, or undefined for any element. */
  key?: string;
  /** Set when the selector targets a pseudo-element of the subject, e.g. `before`. */
  pseudoElement?: string;
  specificity: Specificity;
}

/** Pseudo-classes for interactive or browser states, which never match on paper. */
const NEVER = new Set([
  "hover", "focus", "focus-visible", "focus-within", "active", "visited", "target", "target-within",
  "checked", "indeterminate", "default", "placeholder-shown", "autofill", "-webkit-autofill",
  "invalid", "user-invalid", "user-valid", "popover-open", "modal", "fullscreen", "picture-in-picture",
  "playing", "paused", "open", "closed", "current", "past", "future", "host", "focus-ring", "-moz-focusring",
  "-moz-ui-invalid", "-moz-ui-valid", "local-link", "blank", "in-range", "out-of-range", "valid",
]);
/** Pseudo-classes that always match a static document. */
const ALWAYS = new Set(["defined", "enabled", "read-write", "optional", "scope-root"]);

export function parseSelector(text: string): Selector | undefined {
  try {
    const p = new Parser(text.trim());
    const s = p.complex();
    p.ws();
    return p.done() ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Parses a comma-separated list; undefined when any member is unsupported. */
export function parseSelectorList(text: string): Selector[] | undefined {
  try {
    const p = new Parser(text.trim());
    const list = p.list();
    return p.done() ? list : undefined;
  } catch {
    return undefined;
  }
}

class Unsupported extends Error {}

class Parser {
  pos = 0;
  constructor(readonly src: string) {}

  done(): boolean {
    return this.pos >= this.src.length;
  }
  peek(n = 0): string {
    return this.src[this.pos + n] ?? "";
  }
  ws(): boolean {
    const start = this.pos;
    while (/\s/.test(this.peek())) this.pos++;
    return this.pos > start;
  }

  list(): Selector[] {
    const out: Selector[] = [];
    for (;;) {
      this.ws();
      out.push(this.complex());
      this.ws();
      if (this.peek() !== ",") return out;
      this.pos++;
    }
  }

  /** A complex selector, stopping at `,` or `)`. */
  complex(): Selector {
    const parts: Part[] = [];
    const spec: Specificity = [0, 0, 0];
    let pseudoElement: string | undefined;
    let combinator: Combinator | null = null;
    this.ws();
    // A leading combinator (relative selector in :has) is relative to the subject.
    if (/[>+~]/.test(this.peek())) {
      combinator = this.peek() as Combinator;
      this.pos++;
      this.ws();
      parts.push({ compound: { tests: [] }, combinator: null });
    }
    for (;;) {
      if (pseudoElement) throw new Unsupported(); // Nothing may follow a pseudo-element's compound.
      const { compound, pseudo } = this.compound(spec);
      parts.push({ compound, combinator });
      if (pseudo) pseudoElement = pseudo;
      const hadSpace = this.ws();
      const c = this.peek();
      if (c === "" || c === "," || c === ")") break;
      if (c === ">" || c === "+" || c === "~") {
        this.pos++;
        this.ws();
        combinator = c;
      } else if (hadSpace) combinator = " ";
      else throw new Unsupported();
    }
    if (pseudoElement) spec[2]++;
    const out: Selector = { parts, specificity: spec };
    const key = parts[parts.length - 1]!.compound.key;
    if (key) out.key = key;
    if (pseudoElement) out.pseudoElement = pseudoElement;
    return out;
  }

  compound(spec: Specificity): { compound: Compound; pseudo?: string } {
    const tests: Test[] = [];
    let pseudo: string | undefined;
    let key: string | undefined;
    const start = this.pos;
    for (;;) {
      const c = this.peek();
      if (c === "*") {
        this.pos++;
        if (this.peek() === "|") this.pos++; // `*|E`: any namespace.
      } else if (c === "#") {
        this.pos++;
        const id = this.ident();
        tests.push((el) => el.getAttribute("id") === id);
        key = `#${id}`;
        spec[0]++;
      } else if (c === ".") {
        this.pos++;
        const cls = this.ident();
        tests.push((el) => (el.getAttribute("class") ?? "").split(/\s+/).includes(cls));
        if (!key?.startsWith("#")) key = `.${cls}`;
        spec[1]++;
      } else if (c === "[") {
        tests.push(this.attribute());
        spec[1]++;
      } else if (c === ":" && this.peek(1) === ":") {
        this.pos += 2;
        pseudo = this.ident().toLowerCase();
        if (this.peek() === "(") this.args(); // ::part(), ::slotted()…
      } else if (c === ":") {
        this.pos++;
        const name = this.ident().toLowerCase();
        if (name === "before" || name === "after" || name === "first-line" || name === "first-letter") {
          pseudo = name; // Legacy single-colon pseudo-elements.
          continue;
        }
        tests.push(this.pseudoClass(name, spec));
      } else if (this.pos === start && isIdentStart(c, this.peek(1))) {
        const tag = this.ident().toLowerCase();
        if (this.peek() === "|") {
          this.pos++; // `ns|E`: namespaces are ignored.
          const local = this.ident().toLowerCase();
          tests.push((el) => el.tagName === local);
          key = local;
        } else {
          tests.push((el) => el.tagName === tag);
          key = tag;
        }
        spec[2]++;
      } else break;
    }
    if (this.pos === start) throw new Unsupported();
    const compound: Compound = key ? { tests, key } : { tests };
    return pseudo ? { compound, pseudo } : { compound };
  }

  attribute(): Test {
    this.pos++; // [
    this.ws();
    const name = this.ident().toLowerCase();
    this.ws();
    const op = /^[~|^$*]?=/.exec(this.src.slice(this.pos))?.[0];
    if (!op) {
      this.expect("]");
      return (el) => el.getAttribute(name) !== undefined;
    }
    this.pos += op.length;
    this.ws();
    const value = this.peek() === '"' || this.peek() === "'" ? this.string() : this.ident();
    this.ws();
    let insensitive = false;
    const flag = /^[is](?=\s*\])/i.exec(this.src.slice(this.pos));
    if (flag) {
      insensitive = flag[0].toLowerCase() === "i";
      this.pos++;
      this.ws();
    }
    this.expect("]");
    const want = insensitive ? value.toLowerCase() : value;
    return (el) => {
      const raw = el.getAttribute(name);
      if (raw === undefined) return false;
      const v = insensitive ? raw.toLowerCase() : raw;
      switch (op) {
        case "=": return v === want;
        case "~=": return v.split(/\s+/).includes(want);
        case "|=": return v === want || v.startsWith(`${want}-`);
        case "^=": return want !== "" && v.startsWith(want);
        case "$=": return want !== "" && v.endsWith(want);
        default: return want !== "" && v.includes(want);
      }
    };
  }

  pseudoClass(name: string, spec: Specificity): Test {
    const hasArgs = this.peek() === "(";
    if (!hasArgs) {
      spec[1]++;
      if (NEVER.has(name) || /^-(?:webkit|moz|ms)-/.test(name)) return () => false;
      if (ALWAYS.has(name)) return () => true;
      switch (name) {
        case "root": return (el) => el.parent() === undefined;
        case "scope": return (el) => el.parent() === undefined;
        case "first-child": return (el) => el.position().index === 1;
        case "last-child": return (el) => { const p = el.position(); return p.index === p.count; };
        case "only-child": return (el) => el.position().count === 1;
        case "first-of-type": return (el) => ofType(el).index === 1;
        case "last-of-type": return (el) => { const p = ofType(el); return p.index === p.count; };
        case "only-of-type": return (el) => ofType(el).count === 1;
        case "empty": return (el) => el.isEmpty?.() ?? false;
        case "link":
        case "any-link": return (el) => (el.tagName === "a" || el.tagName === "area") && el.getAttribute("href") !== undefined;
        case "disabled": return (el) => el.getAttribute("disabled") !== undefined;
        case "required": return (el) => el.getAttribute("required") !== undefined;
        case "read-only": return (el) => el.getAttribute("readonly") !== undefined;
      }
      throw new Unsupported();
    }
    const raw = this.args();
    switch (name) {
      case "is":
      case "matches":
      case "-webkit-any":
      case "where":
      case "not": {
        // Forgiving list: unsupported members are dropped (and never match).
        const list = forgivingList(raw);
        if (name !== "where") addSpec(spec, maxSpec(list));
        if (name === "not") return (el) => !list.some((s) => matches(s, el));
        return (el) => list.some((s) => matches(s, el));
      }
      case "has": {
        const list = forgivingList(raw);
        addSpec(spec, maxSpec(list));
        return (el) => list.some((s) => hasMatch(s, el));
      }
      case "nth-child":
      case "nth-last-child":
      case "nth-of-type":
      case "nth-last-of-type": {
        const m = /^(.*?)(?:\s+of\s+(.*))?$/is.exec(raw.trim())!;
        const nth = parseNth(m[1]!);
        if (!nth) throw new Unsupported();
        const of = m[2] ? parseSelectorList(m[2]) : undefined;
        if (m[2] && !of) throw new Unsupported();
        spec[1]++;
        if (of) addSpec(spec, maxSpec(of));
        const last = name.includes("last");
        const typed = name.endsWith("of-type");
        return (el) => {
          const sibs = (el.siblings?.() ?? [el]).filter((s) => (typed ? s.tagName === el.tagName : !of || of.some((x) => matches(x, s))));
          if (of && !of.some((x) => matches(x, el))) return false;
          const i = sibs.indexOf(el);
          if (i === -1 && el.siblings) return false;
          const index = el.siblings ? (last ? sibs.length - i : i + 1) : typed ? 1 : last ? el.position().count - el.position().index + 1 : el.position().index;
          return nthMatches(nth, index);
        };
      }
      case "lang": {
        spec[1]++;
        const langs = raw.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase());
        return (el) => {
          for (let e: SelectorElement | undefined = el; e; e = e.parent()) {
            const l = e.getAttribute("lang");
            if (l !== undefined) return langs.some((x) => l.toLowerCase() === x || l.toLowerCase().startsWith(`${x}-`));
          }
          return false;
        };
      }
      case "dir":
        spec[1]++;
        return () => raw.trim().toLowerCase() === "ltr";
    }
    if (/^-(?:webkit|moz|ms)-/.test(name)) return () => false;
    throw new Unsupported();
  }

  /** Reads a parenthesized argument and returns its text. */
  args(): string {
    const start = ++this.pos;
    let depth = 1;
    let quote = "";
    for (; this.pos < this.src.length; this.pos++) {
      const c = this.src[this.pos]!;
      if (c === "\\") this.pos++;
      else if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return this.src.slice(start, this.pos++);
    }
    throw new Unsupported();
  }

  expect(c: string): void {
    if (this.peek() !== c) throw new Unsupported();
    this.pos++;
  }

  string(): string {
    const quote = this.src[this.pos++];
    let out = "";
    while (this.pos < this.src.length && this.peek() !== quote) {
      if (this.peek() === "\\") out += this.escape();
      else out += this.src[this.pos++];
    }
    this.expect(quote!);
    return out;
  }

  ident(): string {
    let out = "";
    if (!isIdentStart(this.peek(), this.peek(1)) && this.peek() !== "\\" && !(this.peek() === "-" && this.peek(1) === "\\")) {
      throw new Unsupported();
    }
    for (;;) {
      const c = this.peek();
      if (c === "\\") out += this.escape();
      else if (/[-_a-zA-Z0-9]/.test(c) || c.charCodeAt(0) >= 0x80) {
        out += c;
        this.pos++;
      } else return out;
    }
  }

  /** Consumes a backslash escape: `\:` → ":", `\31 ` → "1". */
  escape(): string {
    this.pos++;
    const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(this.src.slice(this.pos));
    if (hex) {
      this.pos += hex[0].length;
      const code = parseInt(hex[0], 16);
      return code === 0 || code > 0x10ffff ? "�" : String.fromCodePoint(code);
    }
    return this.src[this.pos++] ?? "";
  }
}

function isIdentStart(c: string, next: string): boolean {
  if (/[_a-zA-Z]/.test(c) || c.charCodeAt(0) >= 0x80) return true;
  return c === "-" && (/[-_a-zA-Z]/.test(next) || next === "\\" || next.charCodeAt(0) >= 0x80);
}

function forgivingList(text: string): Selector[] {
  return splitList(text).map((s) => parseSelector(s)).filter((s): s is Selector => !!s && !s.pseudoElement);
}

function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      cur += c + (text[++i] ?? "");
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function maxSpec(list: Selector[]): Specificity {
  let best: Specificity = [0, 0, 0];
  for (const s of list) if (compareSpecificity(s.specificity, best) > 0) best = s.specificity;
  return best;
}

function addSpec(into: Specificity, s: Specificity): void {
  into[0] += s[0];
  into[1] += s[1];
  into[2] += s[2];
}

export function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

interface Nth {
  a: number;
  b: number;
}

function parseNth(text: string): Nth | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (t === "odd") return { a: 2, b: 1 };
  if (t === "even") return { a: 2, b: 0 };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t);
  if (m) {
    const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
    return { a, b: Number(m[2] ?? 0) };
  }
  return /^[+-]?\d+$/.test(t) ? { a: 0, b: Number(t) } : undefined;
}

function nthMatches({ a, b }: Nth, index: number): boolean {
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return Number.isInteger(n) && n >= 0;
}

function ofType(el: SelectorElement): { index: number; count: number } {
  const sibs = el.siblings?.().filter((s) => s.tagName === el.tagName);
  if (!sibs) return { index: 1, count: 1 };
  return { index: sibs.indexOf(el) + 1, count: sibs.length };
}

export function matches(selector: Selector, el: SelectorElement): boolean {
  return matchFrom(selector.parts, selector.parts.length - 1, el);
}

function matchFrom(parts: Part[], i: number, el: SelectorElement): boolean {
  const part = parts[i]!;
  if (!part.compound.tests.every((t) => t(el))) return false;
  if (i === 0) return true;
  switch (part.combinator) {
    case ">": {
      const p = el.parent();
      return p !== undefined && matchFrom(parts, i - 1, p);
    }
    case "+": {
      const prev = previousSiblings(el);
      return prev.length > 0 && matchFrom(parts, i - 1, prev[prev.length - 1]!);
    }
    case "~":
      return previousSiblings(el).some((s) => matchFrom(parts, i - 1, s));
    default:
      for (let p = el.parent(); p; p = p.parent()) {
        if (matchFrom(parts, i - 1, p)) return true;
      }
      return false;
  }
}

function previousSiblings(el: SelectorElement): SelectorElement[] {
  const sibs = el.siblings?.() ?? [];
  const i = sibs.indexOf(el);
  return i === -1 ? [] : sibs.slice(0, i);
}

/** `:has()`: a relative selector anchored at `scope` (descendant unless it starts with a combinator). */
function hasMatch(selector: Selector, scope: SelectorElement): boolean {
  const first = selector.parts[0]!;
  const anchored = first.compound.tests.length === 0 && selector.parts.length > 1;
  const lead = anchored ? selector.parts[1]!.combinator : " ";
  const candidates: SelectorElement[] = [];
  const descend = (e: SelectorElement) => {
    for (const c of e.children?.() ?? []) {
      candidates.push(c);
      descend(c);
    }
  };
  if (lead === ">" || lead === " ") {
    if (lead === ">") candidates.push(...(scope.children?.() ?? []));
    else descend(scope);
  } else {
    const sibs = scope.siblings?.() ?? [];
    const after = sibs.slice(sibs.indexOf(scope) + 1);
    candidates.push(...(lead === "+" ? after.slice(0, 1) : after));
  }
  if (!anchored) return candidates.some((c) => matches(selector, c) && within(c, scope));
  // Check the rest of the selector from the candidate, with the anchor at scope.
  const rest: Selector = { parts: selector.parts.slice(1).map((p, i) => (i === 0 ? { ...p, combinator: null } : p)), specificity: selector.specificity };
  return candidates.some((c) => {
    if (!matches(rest, c)) return false;
    if (selector.parts.length === 2) return true;
    return within(c, scope);
  });
}

function within(el: SelectorElement, scope: SelectorElement): boolean {
  for (let p = el.parent(); p; p = p.parent()) if (p === scope) return true;
  return (scope.siblings?.() ?? []).includes(el);
}
