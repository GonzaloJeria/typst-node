import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import readline from "node:readline";
import {
  TypstAbortError,
  TypstBinaryError,
  TypstCompileError,
  TypstDisposedError,
  TypstTimeoutError,
} from "./errors.js";
import type {
  CompileRequest,
  CompileResult,
  Diagnostic,
  FontSource,
  PagesRequest,
  PagesResult,
  TypstBackend,
} from "./types.js";

export interface SidecarBackendOptions {
  /** Path to the `typst-sidecar` binary. Default: `$TYPST_SIDECAR_PATH` or `typst-sidecar` on PATH. */
  binaryPath?: string;
  /** Sidecar processes kept running; each compiles one document at a time. Default: `availableParallelism()`. */
  processes?: number;
  /** Default per-compilation timeout; a timed-out process is killed and replaced. Default: 30 000 ms. */
  timeoutMs?: number;
  /**
   * Fonts added to every compilation. Directories are scanned once when a
   * process starts; font bytes are sent with each request (and parsed once).
   */
  fonts?: readonly FontSource[];
  /** Hide fonts installed on the host, for reproducible output. Default: true. */
  ignoreSystemFonts?: boolean;
  /** Hide the fonts bundled in Typst. Default: false. */
  ignoreEmbeddedFonts?: boolean;
  /** Fixed PDF creation date (UNIX seconds) for byte-reproducible output. */
  creationTimestamp?: number;
  /** Restart a process after this many compilations to bound memory. Default: 500. */
  maxCompilationsPerProcess?: number;
}

interface SidecarResponse {
  id: number;
  ok: boolean;
  output: string[];
  diagnostics: Diagnostic[];
  durationMs: number;
}

interface Job {
  payload: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  resolve(response: SidecarResponse): void;
  reject(error: Error): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const INPUT_KEY = /^[^=\s]+$/;

/**
 * Keeps `typst-sidecar` processes running between documents, so fonts,
 * syntax definitions and Typst's caches are loaded once instead of per
 * compilation. Same contract as `CliBackend`.
 */
export class SidecarBackend implements TypstBackend {
  readonly #binary: string;
  readonly #opts: SidecarBackendOptions;
  readonly #workers: Worker[] = [];
  readonly #queue: Job[] = [];
  readonly #size: number;
  #nextId = 1;
  #disposed = false;

  constructor(options: SidecarBackendOptions = {}) {
    this.#opts = options;
    this.#binary = options.binaryPath ?? process.env.TYPST_SIDECAR_PATH ?? "typst-sidecar";
    this.#size = Math.max(1, options.processes ?? availableParallelism());
  }

  /** Checks that the binary runs; returns its version line. */
  verify(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.#binary, ["--version"], { timeout: 10_000 }, (err, out) => {
        if (err) reject(new TypstBinaryError(notFound(this.#binary, err)));
        else resolve(out.trim());
      });
    });
  }

  /** Starts every process now instead of on first use (e.g. at server startup). */
  async warmup(): Promise<void> {
    while (this.#workers.length < this.#size) this.#spawn();
    await Promise.all(this.#workers.map((w) => w.ready));
  }

  async compile(request: CompileRequest): Promise<CompileResult> {
    const res = await this.#submit(request, { format: "pdf" });
    return { pdf: decode(res.output[0]!), warnings: warningsOf(res), durationMs: res.durationMs };
  }

  async compilePages(request: PagesRequest): Promise<PagesResult> {
    if (request.format !== "png" && request.format !== "svg") {
      throw new TypeError(`Unsupported page format: ${String(request.format)}`);
    }
    const res = await this.#submit(request, { format: request.format, ...(request.ppi ? { ppi: request.ppi } : {}) });
    return { pages: res.output.map(decode), warnings: warningsOf(res), durationMs: res.durationMs };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const job of this.#queue.splice(0)) job.reject(new TypstDisposedError());
    await Promise.all(this.#workers.splice(0).map((w) => w.stop(new TypstDisposedError())));
  }

  async #submit(request: CompileRequest, output: { format: string; ppi?: number }): Promise<SidecarResponse> {
    if (this.#disposed) throw new TypstDisposedError();
    if (request.signal?.aborted) throw new TypstAbortError();
    for (const key of Object.keys(request.inputs ?? {})) {
      if (!INPUT_KEY.test(key)) throw new TypeError(`Invalid input key: ${JSON.stringify(key)}`);
    }
    const files: Record<string, string> = {};
    for (const [name, data] of request.files ?? []) files[virtualPath(name)] = Buffer.from(data).toString("base64");
    const fonts = [...(this.#opts.fonts ?? []), ...(request.fonts ?? [])];
    if (fonts.some((f) => !(f instanceof Uint8Array) && request.fonts?.includes(f))) {
      throw new TypeError("SidecarBackend: per-request fonts must be bytes; pass font directories in the backend options");
    }
    const payload = JSON.stringify({
      id: this.#nextId++,
      source: request.source,
      files,
      fonts: fonts.filter((f): f is Uint8Array => f instanceof Uint8Array).map((f) => Buffer.from(f).toString("base64")),
      inputs: request.inputs ?? {},
      ...output,
      ...(this.#opts.creationTimestamp !== undefined ? { creationTimestamp: Math.trunc(this.#opts.creationTimestamp) } : {}),
    });

    const started = performance.now();
    const res = await new Promise<SidecarResponse>((resolve, reject) => {
      const job: Job = {
        payload,
        timeoutMs: request.timeoutMs ?? this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: request.signal,
        resolve,
        reject,
      };
      const onAbort = () => {
        const i = this.#queue.indexOf(job);
        if (i !== -1) {
          this.#queue.splice(i, 1);
          reject(new TypstAbortError());
        }
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      const settle = <T>(fn: (v: T) => void) => (v: T) => {
        request.signal?.removeEventListener("abort", onAbort);
        fn(v);
      };
      job.resolve = settle(resolve);
      job.reject = settle(reject);
      this.#queue.push(job);
      this.#pump();
    });
    if (!res.ok) {
      const text = res.diagnostics.map((d) => `${d.severity}: ${d.message}`).join("\n");
      throw new TypstCompileError(res.diagnostics, text, 1);
    }
    return { ...res, durationMs: performance.now() - started };
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      let worker = this.#workers.find((w) => w.idle);
      if (!worker && this.#workers.length < this.#size) worker = this.#spawn();
      if (!worker) return;
      worker.run(this.#queue.shift()!);
    }
  }

  #spawn(): Worker {
    const args: string[] = [];
    if (this.#opts.ignoreSystemFonts ?? true) args.push("--ignore-system-fonts");
    if (this.#opts.ignoreEmbeddedFonts) args.push("--ignore-embedded-fonts");
    for (const f of this.#opts.fonts ?? []) if (!(f instanceof Uint8Array)) args.push("--font-path", f.dir);
    const worker = new Worker(this.#binary, args, this.#opts.maxCompilationsPerProcess ?? 500, () => {
      const i = this.#workers.indexOf(worker);
      if (i !== -1) this.#workers.splice(i, 1);
      if (!this.#disposed) this.#pump();
    });
    worker.onIdle = () => this.#pump();
    this.#workers.push(worker);
    return worker;
  }
}

/** One `typst-sidecar` process, compiling one request at a time. */
class Worker {
  readonly ready: Promise<void>;
  onIdle: () => void = () => {};
  #child: ChildProcessWithoutNullStreams;
  #job: Job | undefined;
  #waiters: ((line: string) => void)[] = [];
  #compilations = 0;
  #exited = false;
  #retiring = false;
  #stderr = "";

  constructor(binary: string, args: string[], readonly maxCompilations: number, onExit: () => void) {
    this.#child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child.stdin.on("error", () => {});
    this.#child.stderr.on("data", (c: Buffer) => (this.#stderr = (this.#stderr + c.toString("utf8")).slice(-4000)));
    readline.createInterface({ input: this.#child.stdout }).on("line", (line) => this.#waiters.shift()?.(line));

    let spawnError: Error | undefined;
    this.#child.on("error", (err) => {
      spawnError = new TypstBinaryError(notFound(binary, err));
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.#waiters.push(() => resolve());
      this.#child.on("close", () => reject(spawnError ?? new TypstBinaryError(`typst-sidecar exited during startup: ${this.#stderr.trim()}`)));
    });
    this.ready.catch(() => {});
    // `close` (not `exit`) also fires when the binary could not be spawned.
    this.#child.on("close", (code, signal) => {
      this.#exited = true;
      const job = this.#job;
      this.#job = undefined;
      job?.reject(spawnError ?? new TypstBinaryError(`typst-sidecar exited (${signal ?? code}): ${this.#stderr.trim()}`));
      onExit();
    });
  }

  get idle(): boolean {
    return !this.#job && !this.#exited && !this.#retiring;
  }

  run(job: Job): void {
    this.#job = job;
    const fail = (err: Error) => {
      if (this.#job !== job) return;
      this.#job = undefined;
      job.reject(err);
      // The process may be mid-compilation: replace it rather than wait.
      this.#retiring = true;
      this.#child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(new TypstTimeoutError(job.timeoutMs)), job.timeoutMs);
    const onAbort = () => fail(new TypstAbortError());
    job.signal?.addEventListener("abort", onAbort, { once: true });

    this.ready.then(
      () => {
        if (this.#job !== job) return;
        this.#waiters.push((line) => {
          clearTimeout(timer);
          job.signal?.removeEventListener("abort", onAbort);
          if (this.#job !== job) return;
          this.#job = undefined;
          try {
            job.resolve(JSON.parse(line) as SidecarResponse);
          } catch {
            job.reject(new TypstBinaryError(`Invalid response from typst-sidecar: ${line.slice(0, 200)}`));
          }
          if (++this.#compilations >= this.maxCompilations) {
            this.#retiring = true;
            this.#child.stdin.end();
          }
          else this.onIdle();
        });
        this.#child.stdin.write(job.payload + "\n");
      },
      (err: Error) => {
        clearTimeout(timer);
        job.signal?.removeEventListener("abort", onAbort);
        if (this.#job === job) {
          this.#job = undefined;
          job.reject(err);
        }
      },
    );
  }

  stop(reason: Error): Promise<void> {
    const job = this.#job;
    this.#job = undefined;
    job?.reject(reason);
    this.#retiring = true;
    if (this.#exited) return Promise.resolve();
    return new Promise((resolve) => {
      this.#child.once("close", () => resolve());
      this.#child.kill("SIGKILL");
    });
  }
}

/** Same path rules as the CLI backend's virtual file system. */
function virtualPath(name: string): string {
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized === "" || normalized.split("/").some((seg) => seg === ".." || seg === "" || seg === ".")) {
    throw new TypeError(`Invalid virtual file path: ${JSON.stringify(name)}`);
  }
  return `/${normalized}`;
}

function decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function warningsOf(res: SidecarResponse): Diagnostic[] {
  return res.diagnostics.filter((d) => d.severity === "warning");
}

function notFound(binary: string, err: Error): string {
  return (err as NodeJS.ErrnoException).code === "ENOENT"
    ? `typst-sidecar binary not found at "${binary}". Build it (cargo build --release in crates/typst-sidecar) or set TYPST_SIDECAR_PATH.`
    : `Failed to run typst-sidecar: ${err.message}`;
}
