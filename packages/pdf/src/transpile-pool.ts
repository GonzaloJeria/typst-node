import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { composeToTypst, htmlToTypst, TranspileError, type ComposeInput, type TranspileOptions, type TranspileResult } from "@gjeria/html-to-typst";

/** What the renderer needs from a conversion (the Typst source is emitted later, once images are mapped). */
export type Transpiled = Omit<TranspileResult, "source">;

interface Pending {
  id: number;
  input: string | ComposeInput;
  options: TranspileOptions;
  resolve(r: Transpiled): void;
  reject(e: Error): void;
}

interface Slot {
  worker: Worker;
  job?: Pending | undefined;
  idleTimer?: NodeJS.Timeout | undefined;
}

/** Workers left idle this long are stopped, so a quiet service holds no extra memory. */
const IDLE_MS = 30_000;

const WORKER_FILE = (() => {
  // Built package: dist/transpile-worker.js next to this module. Running from
  // source (tests) there is no compiled worker, and conversion stays inline.
  const file = fileURLToPath(new URL("./transpile-worker.js", import.meta.url));
  return existsSync(file) ? file : undefined;
})();

const TRANSPILE_KEYS = ["css", "rootFontSize", "strict", "genericFamilies", "fontAliases"] as const;

/** Only the transpiler's own options cross into the worker (asset resolvers and signals cannot). */
export function transpileOptions(o: TranspileOptions): TranspileOptions {
  const out: Record<string, unknown> = {};
  for (const k of TRANSPILE_KEYS) if (o[k] !== undefined) out[k] = o[k];
  return out as TranspileOptions;
}

/**
 * Converts HTML to Typst in worker threads: up to `size` documents at once,
 * without blocking the event loop. Workers start on demand and stop after
 * 30 s idle. With `size` 0 (or no compiled worker) it converts inline.
 */
export class TranspilePool {
  readonly #slots: Slot[] = [];
  readonly #queue: Pending[] = [];
  #nextId = 1;
  #disposed = false;

  constructor(readonly size: number) {}

  get enabled(): boolean {
    return this.size > 0 && WORKER_FILE !== undefined;
  }

  /** Workers currently running (they stop when idle). */
  get workers(): number {
    return this.#slots.length;
  }

  run(input: string | ComposeInput, options: TranspileOptions): Promise<Transpiled> {
    const opts = transpileOptions(options);
    if (!this.enabled || this.#disposed) {
      const { source: _source, ...rest } = typeof input === "string" ? htmlToTypst(input, opts) : composeToTypst(input, opts);
      return Promise.resolve(rest);
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ id: this.#nextId++, input, options: opts, resolve, reject });
      this.#pump();
    });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const job of this.#queue.splice(0)) job.reject(new Error("Renderer disposed"));
    await Promise.all(this.#slots.splice(0).map((s) => (clearTimeout(s.idleTimer), s.worker.terminate())));
  }

  #pump(): void {
    while (this.#queue.length) {
      let slot = this.#slots.find((s) => !s.job);
      if (!slot && this.#slots.length < this.size) slot = this.#spawn();
      if (!slot) return;
      const job = this.#queue.shift()!;
      clearTimeout(slot.idleTimer);
      slot.job = job;
      slot.worker.ref();
      slot.worker.postMessage({ id: job.id, input: job.input, options: job.options });
    }
  }

  #spawn(): Slot {
    const worker = new Worker(WORKER_FILE!);
    const slot: Slot = { worker };
    worker.on("message", (msg: { id: number; ok: boolean; result?: Transpiled; error?: { name: string; message: string; stack?: string; warnings?: string[] } }) => {
      const job = slot.job;
      if (!job || job.id !== msg.id) return;
      slot.job = undefined;
      if (msg.ok) job.resolve(msg.result!);
      else {
        const e = msg.error!;
        const err = e.name === "TranspileError" ? new TranspileError(e.warnings ?? []) : Object.assign(new Error(e.message), { name: e.name, stack: e.stack });
        job.reject(err);
      }
      this.#idle(slot);
      this.#pump();
    });
    worker.on("error", (err) => this.#lost(slot, err));
    worker.on("exit", (code) => {
      if (this.#slots.includes(slot)) this.#lost(slot, new Error(`Transpile worker exited with code ${code}`));
    });
    this.#slots.push(slot);
    return slot;
  }

  /** An idle worker does not keep the process alive, and stops after a while. */
  #idle(slot: Slot): void {
    slot.worker.unref();
    slot.idleTimer = setTimeout(() => {
      const i = this.#slots.indexOf(slot);
      if (i === -1 || slot.job) return;
      this.#slots.splice(i, 1);
      void slot.worker.terminate();
    }, IDLE_MS);
    slot.idleTimer.unref();
  }

  /** A crashed worker fails its job and is replaced on demand. */
  #lost(slot: Slot, err: Error): void {
    const i = this.#slots.indexOf(slot);
    if (i !== -1) this.#slots.splice(i, 1);
    clearTimeout(slot.idleTimer);
    slot.job?.reject(err);
    slot.job = undefined;
    if (!this.#disposed) this.#pump();
  }
}
