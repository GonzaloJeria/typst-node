import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Compiler {
  build(candidates: string[]): string;
}

type Compile = (css: string, options: { base: string; onDependency: (path: string) => void }) => Promise<Compiler>;

let loaded: Promise<{ compile: Compile; base: string }> | undefined;

/** Loads Tailwind v4 from the application's dependencies (optional peer). */
function load(): Promise<{ compile: Compile; base: string }> {
  loaded ??= (async () => {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    let entry: string;
    let tailwind: string;
    try {
      entry = require.resolve("@tailwindcss/node");
      tailwind = require.resolve("tailwindcss/package.json");
    } catch {
      // Fall back to this package's own location (workspaces, global installs).
      const own = createRequire(import.meta.url);
      try {
        entry = own.resolve("@tailwindcss/node");
        tailwind = own.resolve("tailwindcss/package.json");
      } catch {
        throw new Error("Tailwind is not installed. Run: npm i tailwindcss @tailwindcss/node");
      }
    }
    const mod = (await import(pathToFileURL(entry).href)) as { compile: Compile };
    // `@import "tailwindcss"` resolves from the directory that holds node_modules/tailwindcss.
    return { compile: mod.compile, base: path.resolve(path.dirname(tailwind), "..", "..") };
  })();
  loaded.catch(() => (loaded = undefined));
  return loaded;
}

const compilers = new Map<string, Promise<Compiler>>();
const MAX_COMPILERS = 50;

/** True when the template asks for Tailwind: the CDN script, `@import "tailwindcss"`, or Tailwind at-rules. */
export function usesTailwind(html: string, css: string): boolean {
  return /<script[^>]+cdn\.tailwindcss\.com/i.test(html) || /@import\s+["']tailwindcss|@(?:tailwind|theme|apply|utility|custom-variant|variant)\b/.test(css);
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
 * Compiles Tailwind for the classes used in `html`. `css` is the template's
 * stylesheet: it may use `@theme`, `@apply`, `@layer`… and gets
 * `@import "tailwindcss"` prepended unless it imports Tailwind itself.
 */
export async function tailwindCss(html: string, css = ""): Promise<string> {
  const input = /@import\s+["']tailwindcss/.test(css) ? css : `@import "tailwindcss";\n${css}`;
  let compiler = compilers.get(input);
  if (!compiler) {
    const { compile, base } = await load();
    compiler = compile(input, { base, onDependency: () => {} });
    compiler.catch(() => compilers.delete(input));
    if (compilers.size >= MAX_COMPILERS) compilers.delete(compilers.keys().next().value!);
    compilers.set(input, compiler);
  }
  return (await compiler).build(classCandidates(html));
}
