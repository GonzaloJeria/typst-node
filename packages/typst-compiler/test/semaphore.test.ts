import { describe, expect, it } from "vitest";
import { TypstAbortError, TypstDisposedError } from "../src/errors.js";
import { Semaphore } from "../src/semaphore.js";

describe("Semaphore", () => {
  it("limits concurrency and serves waiters FIFO", async () => {
    const sem = new Semaphore(2);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    await Promise.all(
      [0, 1, 2, 3, 4].map(async (i) => {
        const release = await sem.acquire();
        order.push(i);
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        release();
      }),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("release is idempotent", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    const a = await sem.acquire();
    let second = false;
    void sem.acquire().then(() => (second = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(second).toBe(false);
    a();
  });

  it("removes aborted waiters from the queue", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const ac = new AbortController();
    const waiting = sem.acquire(ac.signal);
    expect(sem.pending).toBe(1);
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(TypstAbortError);
    expect(sem.pending).toBe(0);
    release();
  });

  it("rejects queued waiters on close", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const waiting = sem.acquire();
    sem.close();
    await expect(waiting).rejects.toBeInstanceOf(TypstDisposedError);
    await expect(sem.acquire()).rejects.toBeInstanceOf(TypstDisposedError);
  });
});
