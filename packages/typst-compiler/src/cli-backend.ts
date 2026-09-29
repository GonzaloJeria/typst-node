import { execFile, spawn, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { parseDiagnostics } from "./diagnostics.js";
import {
  TypstAbortError,
  TypstBinaryError,
  TypstCompileError,
  TypstDisposedError,
  TypstTimeoutError,
} from "./errors.js";
import { Semaphore } from "./semaphore.js";
import type { CompileRequest, CompileResult, FontSource, TypstBackend } from "./types.js";
import { materializeProject } from "./vfs.js";

export interface CliBackendOptions {
  /** Path to the official `typst` binary. Default: `$TYPST_PATH` or `typst` on PATH. */
  binaryPath?: string;
  /** Max compilations running at once. Default: `availableParallelism()`. */
  maxConcurrency?: number;
  /** Default per-compilation timeout. Default: 30 000 ms. */
  timeoutMs?: number;
  /** Fonts added to every compilation. */
  fonts?: readonly FontSource[];
  /** Hide fonts installed on the host, for reproducible output. Default: true. */
  ignoreSystemFonts?: boolean;
  /** Hide the fonts bundled in the Typst binary. Default: false. */
  ignoreEmbeddedFonts?: boolean;
  /**
   * Threads each `typst` process may use (`--jobs`). Default: 1, since
   * parallelism comes from running several processes.
   */
  jobsPerCompilation?: number;
  /** Fixed PDF creation date (UNIX seconds) for byte-reproducible output. */
  creationTimestamp?: number;
  /** Parent directory for per-job temp roots. Default: `os.tmpdir()`. */
  tmpDir?: string;
  /** Minimum accepted Typst version, checked by `verify()`, e.g. `"0.13.0"`. */
  minVersion?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const INPUT_KEY = /^[^=\s]+$/;

export class CliBackend implements TypstBackend {
  readonly #binary: string;
  readonly #semaphore: Semaphore;
  readonly #opts: CliBackendOptions;
  readonly #running = new Set<ChildProcess>();
  #disposed = false;

  constructor(options: CliBackendOptions = {}) {
    this.#opts = options;
    this.#binary = options.binaryPath ?? process.env.TYPST_PATH ?? "typst";
    this.#semaphore = new Semaphore(options.maxConcurrency ?? availableParallelism());
  }

  /** Checks that the binary runs and meets `minVersion`; returns its version. */
  async verify(): Promise<string> {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(this.#binary, ["--version"], { timeout: 10_000 }, (err, out) => {
        if (err) {
          reject(
            new TypstBinaryError(
              (err as NodeJS.ErrnoException).code === "ENOENT"
                ? `Typst binary not found at "${this.#binary}". Install it or set TYPST_PATH.`
                : `Failed to run "${this.#binary} --version": ${err.message}`,
            ),
          );
        } else resolve(out);
      });
    });
    const version = /typst (\d+\.\d+\.\d+)/.exec(stdout)?.[1];
    if (!version) throw new TypstBinaryError(`Unrecognized version output: ${stdout.trim()}`);
    if (this.#opts.minVersion && compareVersions(version, this.#opts.minVersion) < 0) {
      throw new TypstBinaryError(`Typst ${version} is older than required ${this.#opts.minVersion}`);
    }
    return version;
  }

  async compile(request: CompileRequest): Promise<CompileResult> {
    if (this.#disposed) throw new TypstDisposedError();
    for (const key of Object.keys(request.inputs ?? {})) {
      if (!INPUT_KEY.test(key)) throw new TypeError(`Invalid input key: ${JSON.stringify(key)}`);
    }

    const release = await this.#semaphore.acquire(request.signal);
    try {
      const project = await materializeProject(
        request.files,
        [...(this.#opts.fonts ?? []), ...(request.fonts ?? [])],
        this.#opts.tmpDir,
      );
      try {
        return await this.#run(request, project.root, project.fontDirs);
      } finally {
        await project.cleanup();
      }
    } finally {
      release();
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#semaphore.close();
    for (const child of this.#running) child.kill("SIGKILL");
  }

  #args(request: CompileRequest, root: string, fontDirs: string[]): string[] {
    const o = this.#opts;
    const args = ["compile", "--format", "pdf", "--diagnostic-format", "short", "--root", root];
    args.push("--jobs", String(o.jobsPerCompilation ?? 1));
    if (o.ignoreSystemFonts ?? true) args.push("--ignore-system-fonts");
    if (o.ignoreEmbeddedFonts) args.push("--ignore-embedded-fonts");
    for (const dir of fontDirs) args.push("--font-path", dir);
    if (o.creationTimestamp !== undefined) {
      args.push("--creation-timestamp", String(Math.trunc(o.creationTimestamp)));
    }
    for (const [key, value] of Object.entries(request.inputs ?? {})) {
      args.push("--input", `${key}=${value}`);
    }
    args.push("-", "-");
    return args;
  }

  #run(request: CompileRequest, root: string, fontDirs: string[]): Promise<CompileResult> {
    const timeoutMs = request.timeoutMs ?? this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = request.signal;
    const started = performance.now();

    return new Promise<CompileResult>((resolve, reject) => {
      if (signal?.aborted) return reject(new TypstAbortError());

      const child = spawn(this.#binary, this.#args(request, root, fontDirs), {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        // Keep the environment from redirecting roots/fonts behind our back.
        env: sanitizedEnv(),
        windowsHide: true,
      });
      this.#running.add(child);

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let failure: Error | undefined;

      const kill = (err: Error) => {
        failure ??= err;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => kill(new TypstTimeoutError(timeoutMs)), timeoutMs);
      const onAbort = () => kill(new TypstAbortError());
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (c: Buffer) => stdout.push(c));
      child.stderr.on("data", (c: Buffer) => stderr.push(c));
      // EPIPE when the process dies before reading all of stdin; the exit
      // handler reports the real cause.
      child.stdin.on("error", () => {});
      child.stdin.end(request.source, "utf8");

      child.on("error", (err: NodeJS.ErrnoException) => {
        failure ??=
          err.code === "ENOENT"
            ? new TypstBinaryError(`Typst binary not found at "${this.#binary}". Install it or set TYPST_PATH.`)
            : new TypstBinaryError(`Failed to spawn Typst: ${err.message}`);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#running.delete(child);

        if (this.#disposed && !failure && code !== 0) failure = new TypstDisposedError();
        if (failure) return reject(failure);

        const errText = Buffer.concat(stderr).toString("utf8");
        const diagnostics = parseDiagnostics(errText);
        if (code !== 0) return reject(new TypstCompileError(diagnostics, errText, code));

        resolve({
          pdf: new Uint8Array(Buffer.concat(stdout)),
          warnings: diagnostics.filter((d) => d.severity === "warning"),
          durationMs: performance.now() - started,
        });
      });
    });
  }
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TYPST_") && key !== "TYPST_PACKAGE_PATH" && key !== "TYPST_PACKAGE_CACHE_PATH") {
      delete env[key];
    }
  }
  return env;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
