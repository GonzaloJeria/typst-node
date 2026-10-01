import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PageOptions } from "@gjeria/typst-html-pdf";

/** A template: HTML with Handlebars expressions, plus optional CSS and settings. */
export interface TemplateDef {
  /** HTML with `{{variables}}`, `{{#each}}`, partials… A full document or a fragment. */
  html: string;
  /** Template CSS. With Tailwind it may use `@theme`, `@apply` and `@layer`. */
  css?: string;
  /**
   * Page size, margins, background, and a header/footer repeated on every page
   * (`{{page}}` and `{{pages}}` give the page numbers). `@page` in the CSS works too.
   */
  page?: PageOptions;
  /** Partials only this template sees: `{{> name}}`. */
  partials?: Record<string, string>;
  /** Example data, for the preview and `typst-pdf check`. */
  sample?: unknown;
  /** Directory relative images, fonts and `<link>` stylesheets resolve against. */
  baseDir?: string;
  /** Use Tailwind: `true`, `false`, or `"auto"` (default: when the template loads Tailwind). */
  tailwind?: boolean | "auto";
}

/** Where templates come from: a folder, a database, an API… */
export interface TemplateStore {
  get(name: string): Promise<TemplateDef | undefined> | TemplateDef | undefined;
  /** Template names, for the preview and `typst-pdf check`. */
  list?(): Promise<string[]> | string[];
}

export type TemplateSource = TemplateStore | ((name: string) => Promise<TemplateDef | undefined> | TemplateDef | undefined);

export function toStore(source: TemplateSource): TemplateStore {
  return typeof source === "function" ? { get: source } : source;
}

/** Templates from a JS object, e.g. loaded once from a database. */
export function memorySource(templates: Record<string, TemplateDef>): TemplateStore {
  return { get: (name) => templates[name], list: () => Object.keys(templates) };
}

/** File names a template folder may use. */
export const TEMPLATE_FILES = {
  html: ["template.html", "index.html"],
  css: "style.css",
  data: "data.json",
  config: "template.json",
  partials: "partials",
} as const;

/**
 * Templates from folders:
 *
 * ```
 * templates/
 *   _partials/header.html        shared partials: {{> header}}
 *   factura/
 *     template.html              (or index.html)
 *     style.css                  optional
 *     data.json                  optional sample data
 *     template.json              optional: { "page": {…}, "tailwind": true }
 *     partials/linea.html        partials for this template only
 *     logo.png                   assets, relative to the folder
 * ```
 *
 * Files are read on every render, so edits show up without restarting.
 */
export function fileSource(dir: string): TemplateStore {
  const root = path.resolve(dir);
  const htmlFile = (folder: string) => TEMPLATE_FILES.html.map((f) => path.join(folder, f)).find((f) => existsSync(f));
  return {
    async get(name) {
      const folder = path.resolve(root, name);
      if (folder !== root && !folder.startsWith(root + path.sep)) return undefined;
      const file = htmlFile(folder);
      if (!file) return undefined;
      const read = async (f: string) => (existsSync(f) ? readFile(f, "utf8") : undefined);
      const def: TemplateDef = { html: (await read(file))!, baseDir: folder };
      const css = await read(path.join(folder, TEMPLATE_FILES.css));
      if (css !== undefined) def.css = css;
      const data = await read(path.join(folder, TEMPLATE_FILES.data));
      if (data !== undefined) def.sample = parseJson(data, path.join(folder, TEMPLATE_FILES.data));
      const config = await read(path.join(folder, TEMPLATE_FILES.config));
      if (config !== undefined) {
        const c = parseJson(config, path.join(folder, TEMPLATE_FILES.config)) as Pick<TemplateDef, "page" | "tailwind">;
        if (c.page) def.page = c.page;
        if (c.tailwind !== undefined) def.tailwind = c.tailwind;
      }
      const partials = { ...(await readPartials(path.join(root, "_partials"))), ...(await readPartials(path.join(folder, TEMPLATE_FILES.partials))) };
      if (Object.keys(partials).length) def.partials = partials;
      return def;
    },
    async list() {
      const out: string[] = [];
      const walk = async (folder: string) => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === TEMPLATE_FILES.partials) continue;
          const sub = path.join(folder, entry.name);
          if (htmlFile(sub)) out.push(path.relative(root, sub).split(path.sep).join("/"));
          else await walk(sub);
        }
      };
      if (existsSync(root)) await walk(root);
      return out.sort();
    },
  };
}

async function readPartials(dir: string): Promise<Record<string, string>> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const f of await readdir(dir)) {
    if (/\.(html|hbs|handlebars)$/.test(f)) out[f.replace(/\.[^.]+$/, "")] = await readFile(path.join(dir, f), "utf8");
  }
  return out;
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
}
