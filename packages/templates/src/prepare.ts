import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PreparedHtml {
  html: string;
  /** Stylesheets inlined from `<link rel="stylesheet">` to local files, in document order. */
  css: string[];
  /** Google Fonts stylesheet URLs (`fonts.googleapis.com/css…`). */
  googleFonts: string[];
  /** The template loaded the Tailwind CDN (Play CDN) script. */
  tailwindCdn: boolean;
  warnings: string[];
}

const attrOf = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);

/**
 * Turns browser-oriented HTML into what the PDF renderer can use: scripts are
 * removed (nothing runs), local stylesheets are inlined, Google Fonts links are
 * collected so the fonts can be downloaded, and other remote stylesheets are
 * reported.
 */
export async function prepareHtml(source: string, baseDir: string | undefined): Promise<PreparedHtml> {
  const warnings: string[] = [];
  const css: string[] = [];
  const googleFonts: string[] = [];
  let tailwindCdn = false;

  let html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => {
    const open = /^<script\b[^>]*>/i.exec(tag)![0];
    const src = attrOf(open, "src");
    if (src && /cdn\.tailwindcss\.com/i.test(src)) tailwindCdn = true;
    // The Play CDN's inline `tailwind.config = {…}` goes with it.
    else if (!/tailwind\.config\s*=/.test(tag)) warnings.push(`<script${src ? ` src="${src}"` : ""}> was removed: JavaScript does not run when rendering a PDF`);
    return "";
  });

  const links: { tag: string; href: string }[] = [];
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (attrOf(tag, "rel") ?? "").toLowerCase();
    const href = attrOf(tag, "href");
    if (!/\bstylesheet\b/.test(rel) || !href) return /\b(preconnect|dns-prefetch|preload|prefetch|icon)\b/.test(rel) ? "" : tag;
    links.push({ tag, href });
    return "";
  });
  for (const { href } of links) {
    if (/^https?:\/\/fonts\.googleapis\.com\/css/i.test(href)) googleFonts.push(href.replace(/&amp;/g, "&"));
    else if (/^(https?:)?\/\//i.test(href)) warnings.push(`<link rel="stylesheet" href="${href}"> was ignored: remote stylesheets are not downloaded (pass the CSS in the template)`);
    else if (!baseDir) warnings.push(`<link rel="stylesheet" href="${href}"> was ignored: the template has no base directory`);
    else {
      const file = path.resolve(baseDir, href.replace(/[?#].*$/, ""));
      if (!file.startsWith(path.resolve(baseDir) + path.sep)) {
        warnings.push(`<link rel="stylesheet" href="${href}"> was ignored: outside the template directory`);
        continue;
      }
      try {
        css.push(await readFile(file, "utf8"));
      } catch {
        warnings.push(`<link rel="stylesheet" href="${href}"> was ignored: file not found`);
      }
    }
  }
  return { html, css, googleFonts, tailwindCdn, warnings };
}

interface GoogleFont {
  family: string;
  bytes: Uint8Array;
}

const fontCache = new Map<string, Promise<GoogleFont[]>>();

/**
 * Downloads the fonts of a Google Fonts stylesheet. Requested without a
 * browser user agent, Google serves TrueType, which Typst reads.
 */
export function googleFonts(url: string, timeoutMs = 10_000): Promise<GoogleFont[]> {
  let fonts = fontCache.get(url);
  if (!fonts) {
    fonts = (async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const css = await res.text();
      const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].flatMap((m) => {
        const family = /font-family:\s*['"]?([^'";]+)/.exec(m[1]!)?.[1]?.trim();
        const src = /url\(([^)]+\.(?:ttf|otf))\)/.exec(m[1]!)?.[1];
        return family && src ? [{ family, src }] : [];
      });
      const unique = [...new Map(faces.map((f) => [f.src, f])).values()];
      return Promise.all(
        unique.map(async (f) => {
          const r = await fetch(f.src, { signal: AbortSignal.timeout(timeoutMs) });
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${f.src}`);
          return { family: f.family, bytes: new Uint8Array(await r.arrayBuffer()) };
        }),
      );
    })();
    fonts.catch(() => fontCache.delete(url));
    fontCache.set(url, fonts);
  }
  return fonts;
}
