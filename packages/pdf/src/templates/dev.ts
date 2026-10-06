import { createReadStream, existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { PdfTemplates } from "./templates.js";

export interface DevServerOptions {
  templates: PdfTemplates;
  /** Default: 3333. Use 0 for any free port. */
  port?: number;
  /** Default: `127.0.0.1` (only this machine). */
  host?: string;
  /** Folder to watch: the page re-renders when a file changes. */
  watch?: string;
}

export interface DevServer {
  url: string;
  close(): Promise<void>;
}

interface Output {
  pdf: Uint8Array;
  html: string;
  css: string;
  name: string;
}

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".css": "text/css", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};

/**
 * Live preview: the PDF next to the browser rendering of the same HTML, the
 * warnings, and the data as editable JSON. Re-renders when files change.
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const { templates } = options;
  const outputs = new Map<string, Output>();
  let nextId = 1;
  const clients = new Set<ServerResponse>();

  const send = (res: ServerResponse, status: number, type: string, body: string | Uint8Array) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(body));

  const host = options.host ?? "127.0.0.1";
  const loopback = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(host);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS rebinding: a web page cannot reach this server under another name and read templates.
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (loopback && !/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(hostname)) return send(res, 403, "text/plain", "Forbidden host");
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", UI);
    if (url.pathname === "/api/templates") return json(res, 200, await templates.list());
    if (parts[0] === "api" && parts[1] === "template" && parts.length > 2) {
      const def = await templates.get(parts.slice(2).join("/"));
      return json(res, 200, { sample: def.sample ?? {} });
    }
    if (url.pathname === "/api/render" && req.method === "POST") {
      // Only the preview page posts here (a cross-site form cannot send JSON).
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(res, 415, "text/plain", "Expected application/json");
      const body = JSON.parse(await readBody(req)) as { name: string; data?: unknown };
      const started = performance.now();
      try {
        const result = await templates.render(body.name, body.data);
        const id = String(nextId++);
        outputs.set(id, { pdf: result.pdf, html: result.html, css: result.css, name: body.name });
        // Keep the last few renders only.
        for (const key of outputs.keys()) if (outputs.size > 20) outputs.delete(key);
        return json(res, 200, {
          id,
          ms: Math.round(performance.now() - started),
          bytes: result.pdf.length,
          warnings: result.warnings,
          diagnostics: result.diagnostics.map((d) => d.message),
        });
      } catch (err) {
        return json(res, 200, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (parts[0] === "out" && parts[1]) {
      const [id, ext] = parts[1].split(".");
      const out = outputs.get(id ?? "");
      if (!out) return send(res, 404, "text/plain", "Not found");
      if (ext === "pdf") return send(res, 200, "application/pdf", out.pdf);
      // Relative images resolve against the template folder, served under /assets/.
      // The final CSS (Tailwind included) is passed to the renderer apart from the HTML: put it back.
      const base = `<base href="/assets/${out.name.split("/").map(encodeURIComponent).join("/")}/"><style>${out.css.replace(/<\/style/gi, "<\\/style")}</style>`;
      let html = /<head\b[^>]*>/i.test(out.html) ? out.html.replace(/<head\b[^>]*>/i, (h) => h + base) : base + out.html;
      // Show the print styles, as the PDF uses them.
      html = html.replace(/@media\s+print\b/gi, "@media all").replace(/@media\s+screen\b/gi, "@media not all");
      // The rendered template is shown, never run: no scripts, no network beyond this server.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self' data:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' data:; script-src 'none'",
      });
      return res.end(html);
    }
    if (parts[0] === "assets" && parts.length > 2) {
      // The template name may contain slashes: find the longest prefix that is a template.
      for (let i = parts.length - 1; i > 1; i--) {
        const name = parts.slice(1, i).join("/");
        const def = await Promise.resolve(templates.store?.get(name)).catch(() => undefined);
        if (!def?.baseDir) continue;
        const file = path.resolve(def.baseDir, parts.slice(i).join("/"));
        if (!file.startsWith(path.resolve(def.baseDir) + path.sep) || !existsSync(file) || !statSync(file).isFile()) break;
        res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
        createReadStream(file).pipe(res);
        return;
      }
      return send(res, 404, "text/plain", "Not found");
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    send(res, 404, "text/plain", "Not found");
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  let watcher: FSWatcher | undefined;
  if (options.watch && existsSync(options.watch)) {
    let timer: NodeJS.Timeout | undefined;
    watcher = watch(options.watch, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const c of clients) c.write("data: change\n\n");
      }, 100);
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3333, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    async close() {
      watcher?.close();
      for (const c of clients) c.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const UI = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>typdf · preview</title>
<style>
  :root { --bg: #f4f4f5; --panel: #fff; --line: #e4e4e7; --text: #18181b; --muted: #71717a; --accent: #4f46e5; --warn: #b45309; --err: #b91c1c; }
  * { box-sizing: border-box }
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; color: var(--text); background: var(--bg); height: 100vh; display: grid; grid-template-columns: 220px 1fr; }
  aside { background: var(--panel); border-right: 1px solid var(--line); overflow: auto; }
  aside h1 { font-size: 13px; margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  aside a { display: block; padding: 7px 16px; color: inherit; text-decoration: none; border-left: 3px solid transparent; }
  aside a.on { background: #eef2ff; border-left-color: var(--accent); font-weight: 600; }
  aside p { padding: 8px 16px; color: var(--muted); }
  main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; min-height: 0; }
  header { display: flex; gap: 12px; align-items: center; padding: 8px 14px; background: var(--panel); border-bottom: 1px solid var(--line); }
  header b { font-size: 14px; }
  header .meta { color: var(--muted); margin-left: auto; }
  button, label.toggle { font: inherit; padding: 4px 10px; border: 1px solid var(--line); background: #fff; border-radius: 6px; cursor: pointer; }
  .views { display: grid; grid-template-columns: 1fr 1fr 320px; min-height: 0; }
  .views.single { grid-template-columns: 1fr 320px; }
  .views.single .browser { display: none; }
  .views.nodata { grid-template-columns: 1fr 1fr; }
  .views.single.nodata { grid-template-columns: 1fr; }
  .views.nodata .data { display: none; }
  .pane { display: grid; grid-template-rows: auto 1fr; min-height: 0; border-right: 1px solid var(--line); }
  .pane > span { padding: 4px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); background: var(--panel); border-bottom: 1px solid var(--line); }
  iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  .browser { overflow: hidden; }
  .browser .page { position: relative; overflow: auto; background: #e4e4e7; }
  .browser iframe { width: 794px; height: 1123px; transform-origin: 0 0; box-shadow: 0 1px 4px #0002; }
  textarea { width: 100%; height: 100%; border: 0; resize: none; padding: 10px; font: 12px/1.45 ui-monospace, monospace; outline: none; }
  textarea.bad { background: #fef2f2; }
  footer { max-height: 30vh; overflow: auto; background: var(--panel); border-top: 1px solid var(--line); }
  footer li { padding: 4px 14px; border-bottom: 1px solid var(--line); list-style: none; font-family: ui-monospace, monospace; font-size: 12px; color: var(--warn); }
  footer li.err { color: var(--err); white-space: pre-wrap; }
  footer li.ok { color: #15803d; }
  footer li.info { color: var(--muted); }
  footer ul { margin: 0; padding: 0; }
  .empty { display: grid; place-items: center; color: var(--muted); }
</style>
</head>
<body>
<aside><h1>📄 Templates</h1><nav id="list"></nav></aside>
<main>
  <header>
    <b id="name">—</b>
    <button id="reload" title="Volver a renderizar">↻ Renderizar</button>
    <label class="toggle"><input type="checkbox" id="compare" checked> Comparar con el navegador</label>
    <label class="toggle"><input type="checkbox" id="showData" checked> Datos</label>
    <span class="meta" id="meta"></span>
  </header>
  <div class="views" id="views">
    <div class="pane"><span>PDF (Typst)</span><iframe id="pdf" title="PDF"></iframe></div>
    <div class="pane browser"><span>Navegador (A4, estilos de impresión)</span><div class="page" id="page"><iframe id="html" title="HTML"></iframe></div></div>
    <div class="pane data"><span>Datos (JSON)</span><textarea id="data" spellcheck="false"></textarea></div>
  </div>
  <footer><ul id="warnings"></ul></footer>
</main>
<script>
const $ = (id) => document.getElementById(id);
let current = null, data = null, timer = null, busy = false, again = false;
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
async function loadList(reselect = true) {
  const names = await (await fetch("/api/templates")).json();
  $("list").innerHTML = names.length ? names.map((n) => '<a href="#' + encodeURIComponent(n) + '">' + esc(n) + "</a>").join("") : "<p>Sin templates. Crea uno con <code>typdf new nombre</code>.</p>";
  document.querySelectorAll("#list a").forEach((a) => a.classList.toggle("on", decodeURIComponent(a.hash.slice(1)) === current));
  if (!reselect) return;
  if (!location.hash && names[0]) location.hash = encodeURIComponent(names[0]);
  else select();
}
async function select() {
  const name = decodeURIComponent(location.hash.slice(1));
  if (!name) return;
  current = name;
  document.querySelectorAll("#list a").forEach((a) => a.classList.toggle("on", decodeURIComponent(a.hash.slice(1)) === name));
  $("name").textContent = name;
  const r = await (await fetch("/api/template/" + name.split("/").map(encodeURIComponent).join("/"))).json();
  data = r.sample ?? {};
  $("data").value = JSON.stringify(data, null, 2);
  $("data").classList.remove("bad");
  render();
}
async function render() {
  if (!current) return;
  if (busy) { again = true; return; }
  busy = true;
  $("meta").textContent = "renderizando…";
  try {
    const r = await (await fetch("/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: current, data }) })).json();
    if (r.error) {
      $("warnings").innerHTML = '<li class="err">' + esc(r.error) + "</li>";
      $("meta").textContent = "error";
    } else {
      $("pdf").src = "/out/" + r.id + ".pdf#toolbar=0&view=FitH";
      $("html").src = "/out/" + r.id + ".html";
      const items = [...r.warnings, ...r.diagnostics];
      const info = (w) => w.startsWith("fonts not available");
      const warn = items.filter((w) => !info(w));
      $("warnings").innerHTML = (warn.length ? warn.map((w) => "<li>⚠ " + esc(w) + "</li>").join("") : '<li class="ok">✓ Sin warnings</li>') +
        items.filter(info).map((w) => '<li class="info">ℹ ' + esc(w) + "</li>").join("");
      $("meta").textContent = r.ms + " ms · " + (r.bytes / 1024).toFixed(1) + " KB";
    }
  } finally {
    busy = false;
    if (again) { again = false; render(); }
  }
}
$("data").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { data = JSON.parse($("data").value); $("data").classList.remove("bad"); render(); }
    catch { $("data").classList.add("bad"); }
  }, 400);
});
// The browser view is laid out at A4 width (794 px), like the PDF, and scaled to fit.
function fit() { const k = Math.min(1, $("page").clientWidth / 794); $("html").style.transform = "scale(" + k + ")"; }
new ResizeObserver(fit).observe($("page"));
$("reload").onclick = render;
$("compare").onchange = (e) => $("views").classList.toggle("single", !e.target.checked);
$("showData").onchange = (e) => $("views").classList.toggle("nodata", !e.target.checked);
addEventListener("hashchange", select);
// A file changed: re-render with the data being edited (click the template to reload data.json).
new EventSource("/events").onmessage = () => { loadList(false); render(); };
loadList();
</script>
</body>
</html>`;
