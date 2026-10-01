/**
 * Tailwind CSS v4, bundled: the `tailwindcss` package compiles in plain
 * JavaScript (no native binaries), so it works wherever the renderer does.
 * CSS is generated only for the classes the HTML uses.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

interface Compiler {
  build(candidates: string[]): string;
}

interface LoadedStylesheet {
  path: string;
  base: string;
  content: string;
}

type Compile = (
  css: string,
  options: {
    base: string;
    loadStylesheet: (id: string, base: string) => Promise<LoadedStylesheet>;
    loadModule: (id: string) => Promise<never>;
  },
) => Promise<Compiler>;

const req = createRequire(import.meta.url);
let tailwind: { compile: Compile; dir: string } | undefined;

function load(): { compile: Compile; dir: string } {
  if (!tailwind) {
    const mod = req("tailwindcss") as { compile: Compile };
    tailwind = { compile: mod.compile, dir: path.dirname(req.resolve("tailwindcss/package.json")) };
  }
  return tailwind;
}

export interface TailwindOptions {
  /** Directory relative `@import "./file.css"` resolve against. Without it they fail. */
  baseDir?: string;
  /** Page width in CSS px, to report breakpoints that never apply. Default: A4 (794). */
  pageWidth?: number;
}

export interface TailwindResult {
  css: string;
  /** Classes that do nothing in a PDF: unknown names, screen-only breakpoints, interaction states. */
  warnings: string[];
}

/**
 * Prepended to the template CSS: the font stacks name the PDF's own fonts
 * (Inter, Libertinus Serif, DejaVu Sans Mono) instead of a dozen desktop
 * fonts that are never installed. A template's own `@theme` still wins.
 */
const PDF_THEME = `@theme {
  --font-sans: sans-serif;
  --font-serif: serif;
  --font-mono: monospace;
}`;

const compilers = new Map<string, Promise<Compiler>>();
const MAX_COMPILERS = 50;

function compiler(input: string, baseDir: string | undefined): Promise<Compiler> {
  const key = `${baseDir ?? ""}\0${input}`;
  let c = compilers.get(key);
  if (!c) {
    const { compile, dir } = load();
    c = compile(input, {
      base: baseDir ?? dir,
      async loadStylesheet(id, base) {
        // `tailwindcss`, `tailwindcss/theme`, `tailwindcss/preflight.css`… come from the bundled package.
        const pkg = /^tailwindcss(?:\/(theme|preflight|utilities|index)(?:\.css)?)?$/.exec(id);
        if (pkg) {
          const file = path.join(dir, `${pkg[1] ?? "index"}.css`);
          return { path: file, base: dir, content: await readFile(file, "utf8") };
        }
        if (!baseDir || !/^\.{0,2}\//.test(id)) throw new Error(`Cannot @import "${id}": only "tailwindcss" and files relative to the template are supported`);
        const file = path.resolve(base, id);
        if (!file.startsWith(path.resolve(baseDir) + path.sep)) throw new Error(`Cannot @import "${id}": outside the template directory`);
        return { path: file, base: path.dirname(file), content: await readFile(file, "utf8") };
      },
      async loadModule(id) {
        throw new Error(`Tailwind plugins and JS config are not supported (@plugin/@config "${id}"): use @theme, @utility and @custom-variant in CSS`);
      },
    });
    c.catch(() => compilers.delete(key));
    if (compilers.size >= MAX_COMPILERS) compilers.delete(compilers.keys().next().value!);
    compilers.set(key, c);
  }
  return c;
}

/** Class names used in the HTML: the candidates Tailwind generates CSS for. */
export function classCandidates(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const c of (m[1] ?? m[2] ?? "").split(/\s+/)) if (c) out.add(c);
  }
  return [...out];
}

/**
 * Compiles Tailwind for the classes used in `html`. `css` is the document's
 * own stylesheet: it may use `@theme`, `@apply`, `@utility`, `@layer`… and
 * gets `@import "tailwindcss"` unless it imports Tailwind itself.
 */
export async function tailwindCss(html: string, css = "", options: TailwindOptions = {}): Promise<TailwindResult> {
  const imports = /@import\s+["']tailwindcss/.test(css);
  const input = imports ? css : `@import "tailwindcss";\n${PDF_THEME}\n${css}`;
  const candidates = classCandidates(html);
  const out = (await compiler(input, options.baseDir)).build(candidates);
  return { css: out, warnings: classWarnings(candidates, out, input, options.pageWidth ?? pageWidth(css)) };
}

// ── Warnings ─────────────────────────────────────────────────────────────────

/** Tailwind's default breakpoints in px (`--breakpoint-*`, rem × 16). */
const BREAKPOINTS: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };

/** Variants for states a printed page never has. */
const NEVER = /^(?:hover|focus|focus-within|focus-visible|active|visited|target|group-hover|group-focus|peer-hover|peer-focus|peer-checked|dark|motion-safe|motion-reduce|pointer-fine|pointer-coarse|any-pointer-fine|any-pointer-coarse|portrait|forced-colors|contrast-more|contrast-less|noscript|inert|open|starting)$/;

const PAPER_PX: Record<string, [number, number]> = {
  a3: [1123, 1587], a4: [794, 1123], a5: [559, 794], a6: [397, 559], letter: [816, 1056], legal: [816, 1344],
  "jis-b5": [688, 971], "jis-b4": [971, 1376], "b5": [665, 945], "b4": [945, 1334],
};

/** The page width in CSS px from the first `@page { size }`, A4 by default. */
export function pageWidth(css: string): number {
  const size = /@page\s*{[^}]*?\bsize\s*:\s*([^;}]+)/i.exec(css)?.[1]?.trim().toLowerCase();
  if (!size) return PAPER_PX.a4![0];
  const tokens = size.split(/\s+/);
  const paper = tokens.map((t) => PAPER_PX[t]).find(Boolean);
  if (paper) return tokens.includes("landscape") ? paper[1] : paper[0];
  const len = /^(\d*\.?\d+)(mm|cm|in|px|pt)$/.exec(tokens[0] ?? "");
  const k: Record<string, number> = { mm: 96 / 25.4, cm: 96 / 2.54, in: 96, px: 1, pt: 4 / 3 };
  return len ? Number(len[1]) * k[len[2]!]! : PAPER_PX.a4![0];
}

/** CSS identifier escaping (`CSS.escape`), as Tailwind writes class selectors. */
function cssEscape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const code = ch.charCodeAt(0);
    if (code === 0) out += "�";
    else if ((code >= 1 && code <= 31) || code === 127 || (i === 0 && code >= 48 && code <= 57) || (i === 1 && code >= 48 && code <= 57 && value[0] === "-")) {
      out += `\\${code.toString(16)} `;
    } else if (i === 0 && ch === "-" && value.length === 1) out += `\\${ch}`;
    else if (code >= 128 || ch === "-" || ch === "_" || /[0-9a-zA-Z]/.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

function classWarnings(candidates: string[], css: string, input: string, width: number): string[] {
  const warnings: string[] = [];
  const breakpoints = { ...BREAKPOINTS };
  // A template's own @theme may move or add breakpoints.
  for (const m of input.matchAll(/--breakpoint-([\w-]+)\s*:\s*([\d.]+)(rem|px|em)/g)) {
    breakpoints[m[1]!] = Number(m[2]) * (m[3] === "px" ? 1 : 16);
  }
  const never = new Map<string, string[]>();
  const screen: string[] = [];
  for (const c of candidates) {
    const variants = c.split(/:(?![^[]*\])/).slice(0, -1);
    const state = variants.find((v) => NEVER.test(v));
    if (state) {
      never.set(state, [...(never.get(state) ?? []), c]);
      continue;
    }
    // `lg:` needs a page at least that wide; `max-lg:` always applies on a narrower one.
    const bp = variants.find((v) => v in breakpoints);
    if (bp && breakpoints[bp]! > width) {
      const fits = Object.entries(breakpoints).filter(([, px]) => px <= width).sort((a, b) => b[1] - a[1])[0]?.[0];
      screen.push(`${c} (${bp}: starts at ${breakpoints[bp]}px${fits ? `; use ${fits}: or no prefix` : "; use no prefix"})`);
      continue;
    }
    // Neither Tailwind nor the document's CSS styles this class.
    if (/[-:[]/.test(c) && !css.includes(`.${cssEscape(c)}`)) warnings.push(`Unknown class, no CSS generated: ${c}`);
  }
  if (screen.length) warnings.push(`Breakpoints wider than the page (${Math.round(width)}px) never apply: ${screen.join(", ")}`);
  for (const [state, classes] of never) warnings.push(`${state}: never applies in a PDF: ${classes.join(", ")}`);
  return warnings;
}
