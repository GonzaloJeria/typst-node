import { createHash } from "node:crypto";
import Handlebars, { type HelperDelegate, type TemplateDelegate } from "handlebars";
import { PdfRenderer, type PageOptions, type PagesResult, type PdfRendererOptions, type PdfResult, type RenderInput, type RenderOptions } from "@gjeria/typst-html-pdf";
import { builtinHelpers, type FormatOptions } from "./helpers.js";
import { googleFonts, prepareHtml } from "./prepare.js";
import { fileSource, toStore, type TemplateDef, type TemplateSource, type TemplateStore } from "./sources.js";
import { pageWidth, tailwindCss } from "@gjeria/typst-html-pdf";
import { usesTailwind } from "./tailwind.js";

export interface TemplatesOptions extends FormatOptions {
  /** Where named templates come from: a folder path, a store, or `(name) => TemplateDef`. */
  source?: TemplateSource | string;
  /** Renderer to use (shared with other code). Default: one created and owned by this instance. */
  renderer?: PdfRenderer;
  /** Options for the renderer this instance creates (sidecar processes, assets, fonts…). */
  rendererOptions?: PdfRendererOptions;
  /**
   * Tailwind CSS v4 (bundled): `true` (default), `false` for plain-CSS templates
   * (no Tailwind reset), or `"auto"` (only when the template loads Tailwind).
   */
  tailwind?: boolean | "auto";
  /** Download fonts from `<link href="https://fonts.googleapis.com/css2?…">`. Default: true. */
  googleFonts?: boolean;
  /** Extra Handlebars helpers. */
  helpers?: Record<string, HelperDelegate>;
  /** Partials every template sees: `{{> name}}`. */
  partials?: Record<string, string>;
  /** Fail when a template uses a variable that is not in the data. Default: false. */
  strictData?: boolean;
}

/** The HTML and CSS a template produced for some data, before the PDF. */
export interface RenderedTemplate {
  html: string;
  css: string;
  page?: PageOptions;
  /** Fonts downloaded for the template (Google Fonts). */
  fonts: Uint8Array[];
  baseDir?: string;
  /** What the template does that a PDF cannot (scripts, remote stylesheets…). */
  warnings: string[];
}

export interface TemplateResult extends PdfResult {
  /** The HTML that was rendered, after Handlebars. */
  html: string;
  /** The final CSS (Tailwind included). */
  css: string;
}

export interface TemplatePagesResult extends PagesResult {
  html: string;
  css: string;
}

export class TemplateNotFoundError extends Error {
  override name = "TemplateNotFoundError";
  constructor(readonly template: string) {
    super(`Template not found: ${template}`);
  }
}

export class TemplateError extends Error {
  override name = "TemplateError";
  constructor(readonly template: string, cause: unknown) {
    super(`Template ${template}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

const MAX_COMPILED = 200;

/**
 * Template-based PDFs: Handlebars templates (from files, a database or
 * inline), with Tailwind and Google Fonts handled for you.
 *
 * ```ts
 * const templates = createTemplates({ source: "./templates" });
 * const { pdf } = await templates.render("factura", { cliente, items });
 * ```
 */
export class PdfTemplates {
  readonly renderer: PdfRenderer;
  readonly store: TemplateStore | undefined;
  readonly #owned: boolean;
  readonly #options: TemplatesOptions;
  readonly #hb: typeof Handlebars;
  readonly #compiled = new Map<string, TemplateDelegate>();

  constructor(options: TemplatesOptions = {}) {
    this.#options = options;
    this.renderer = options.renderer ?? new PdfRenderer(options.rendererOptions);
    this.#owned = !options.renderer;
    const source = options.source;
    this.store = source === undefined ? undefined : typeof source === "string" ? fileSource(source) : toStore(source);
    this.#hb = Handlebars.create();
    this.#hb.registerHelper({ ...builtinHelpers(options), ...options.helpers });
    if (options.partials) this.#hb.registerPartial(options.partials);
  }

  /** Loads a named template from the source. */
  async get(name: string): Promise<TemplateDef> {
    if (!this.store) throw new Error(`No template source configured: pass \`source\` to createTemplates() to render "${name}" by name`);
    const def = await this.store.get(name);
    if (!def) throw new TemplateNotFoundError(name);
    return def;
  }

  /** Names of the templates in the source (when it can list them). */
  async list(): Promise<string[]> {
    return (await this.store?.list?.()) ?? [];
  }

  /**
   * Runs a template: Handlebars with `data` (or the template's sample data),
   * then scripts, stylesheets, Tailwind and Google Fonts are resolved.
   */
  async html(template: string | TemplateDef, data?: unknown): Promise<RenderedTemplate> {
    const name = typeof template === "string" ? template : "(inline)";
    const def = typeof template === "string" ? await this.get(template) : template;
    const context = data ?? def.sample ?? {};
    let source: string;
    try {
      source = this.#run(def.html, context, def.partials);
    } catch (err) {
      throw new TemplateError(name, err);
    }
    const prepared = await prepareHtml(source, def.baseDir);
    const warnings = [...prepared.warnings];
    let html = prepared.html;
    let css = [...prepared.css, def.css ?? ""].filter(Boolean).join("\n");

    const mode = def.tailwind ?? this.#options.tailwind ?? true;
    if (mode === true || (mode === "auto" && (prepared.tailwindCdn || usesTailwind(html, css)))) {
      // Inline <style> blocks go through Tailwind too, so they can use @apply and theme variables.
      const inline: string[] = [];
      html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_, body: string) => (inline.push(body), ""));
      try {
        const source = [...inline, css].join("\n");
        const width = pageWidth(def.page?.size ? `@page { size: ${def.page.size} }` : source);
        const tw = await tailwindCss(`${html}\n${def.page?.header || ""}\n${def.page?.footer || ""}`, source, { pageWidth: width, ...(def.baseDir ? { baseDir: def.baseDir } : {}) });
        css = tw.css;
        warnings.push(...tw.warnings);
      } catch (err) {
        throw new TemplateError(name, err);
      }
    }

    const fonts: Uint8Array[] = [];
    if (prepared.googleFonts.length) {
      if (this.#options.googleFonts === false) {
        for (const url of prepared.googleFonts) warnings.push(`Google Fonts stylesheet ignored (googleFonts: false): ${url}`);
      } else {
        for (const url of prepared.googleFonts) {
          try {
            fonts.push(...(await googleFonts(url)).map((f) => f.bytes));
          } catch (err) {
            warnings.push(`Google Fonts could not be downloaded (${(err as Error).message}): ${url}`);
          }
        }
      }
    }

    const out: RenderedTemplate = { html, css, fonts, warnings };
    if (def.page) out.page = this.#page(def.page, context, def.partials);
    if (def.baseDir) out.baseDir = def.baseDir;
    return out;
  }

  /** Renders a template to a PDF. `template` is a name in the source or a template object. */
  async render(template: string | TemplateDef, data?: unknown, options: RenderOptions = {}): Promise<TemplateResult> {
    const t = await this.html(template, data);
    const result = await this.renderer.render(input(t), renderOptions(t, options));
    return { ...result, ...fontFallbacks(result.diagnostics), warnings: [...t.warnings, ...result.warnings], html: t.html, css: t.css };
  }

  /** Renders a template to one image per page (PNG by default), e.g. for thumbnails. */
  async renderPages(
    template: string | TemplateDef,
    data?: unknown,
    options: RenderOptions & { format?: "png" | "svg"; ppi?: number } = {},
  ): Promise<TemplatePagesResult> {
    const t = await this.html(template, data);
    const result = await this.renderer.renderPages(input(t), { ...renderOptions(t, options), ...(options.format ? { format: options.format } : {}), ...(options.ppi ? { ppi: options.ppi } : {}) });
    return { ...result, ...fontFallbacks(result.diagnostics), warnings: [...t.warnings, ...result.warnings], html: t.html, css: t.css };
  }

  /** Starts the renderer's processes ahead of the first request. */
  warmup(): Promise<void> {
    return this.renderer.warmup();
  }

  async dispose(): Promise<void> {
    if (this.#owned) await this.renderer.dispose();
  }

  #run(text: string, context: unknown, partials?: Record<string, string>): string {
    const key = createHash("sha1").update(text).digest("base64");
    let fn = this.#compiled.get(key);
    if (!fn) {
      fn = this.#hb.compile(text, { strict: this.#options.strictData === true });
      if (this.#compiled.size >= MAX_COMPILED) this.#compiled.delete(this.#compiled.keys().next().value!);
      this.#compiled.set(key, fn);
    }
    return fn(context, partials ? { partials } : {});
  }

  /** Header and footer HTML run through Handlebars too, keeping `{{page}}` and `{{pages}}`. */
  #page(page: PageOptions, context: unknown, partials?: Record<string, string>): PageOptions {
    const out: PageOptions = { ...page };
    const counters = { page: "{{page}}", pages: "{{pages}}" };
    const scope = context && typeof context === "object" && !Array.isArray(context) ? { ...context, ...counters } : counters;
    for (const key of ["header", "footer"] as const) {
      const v = page[key];
      if (typeof v === "string") out[key] = this.#run(v, scope, partials);
    }
    return out;
  }
}

/**
 * CSS font stacks name fonts that are often missing (`"Segoe UI", Roboto,
 * Arial…`); Typst reports each one. Keep the first of them only, as a summary.
 */
function fontFallbacks(diagnostics: PdfResult["diagnostics"]): { diagnostics: PdfResult["diagnostics"] } {
  const missing = diagnostics.filter((d) => /^unknown font family: /.test(d.message));
  if (missing.length < 2) return { diagnostics };
  const families = missing.map((d) => d.message.replace(/^unknown font family: /, ""));
  return {
    diagnostics: [
      ...diagnostics.filter((d) => !missing.includes(d)),
      { ...missing[0]!, message: `fonts not available, the next font in the CSS stack was used: ${families.join(", ")}` },
    ],
  };
}

function input(t: RenderedTemplate): RenderInput {
  return t.page ? { layout: { page: t.page }, sections: [{ html: t.html, css: t.css }] } : t.html;
}

function renderOptions(t: RenderedTemplate, options: RenderOptions): RenderOptions {
  return {
    ...options,
    ...(t.page ? {} : { css: options.css ? `${t.css}\n${options.css}` : t.css }),
    ...(t.fonts.length ? { fonts: [...(options.fonts ?? []), ...t.fonts] } : {}),
    ...(t.baseDir ? { assets: { baseDir: t.baseDir, ...options.assets } } : {}),
  };
}

export function createTemplates(options: TemplatesOptions = {}): PdfTemplates {
  return new PdfTemplates(options);
}
