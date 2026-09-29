import { TypstAbortError, TypstDisposedError } from "./errors.js";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
}

/** FIFO counting semaphore with AbortSignal support. */
export class Semaphore {
  #available: number;
  #queue: Waiter[] = [];
  #closed = false;

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(`permits must be a positive integer, got ${permits}`);
    }
    this.#available = permits;
  }

  get pending(): number {
    return this.#queue.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.#closed) return Promise.reject(new TypstDisposedError());
    if (signal?.aborted) return Promise.reject(new TypstAbortError());
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      };
      const onAbort = () => {
        const i = this.#queue.indexOf(waiter);
        if (i !== -1) this.#queue.splice(i, 1);
        waiter.reject(new TypstAbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  /** Rejects every queued waiter; permits already held stay valid. */
  close(): void {
    this.#closed = true;
    for (const waiter of this.#queue.splice(0)) waiter.reject(new TypstDisposedError());
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) next.resolve(this.#releaser());
      else this.#available++;
    };
  }
}
