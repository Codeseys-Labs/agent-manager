import { describe, expect, test } from "bun:test";
import { AsyncMutex, KeyedMutex } from "../../src/core/locks";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AsyncMutex", () => {
  test("serializes concurrent callers — no interleaving", async () => {
    const mutex = new AsyncMutex();
    const log: string[] = [];

    async function worker(id: string, delay: number) {
      await mutex.withLock(async () => {
        log.push(`${id}:enter`);
        await new Promise((r) => setTimeout(r, delay));
        log.push(`${id}:exit`);
      });
    }

    await Promise.all([worker("a", 20), worker("b", 5), worker("c", 10)]);

    // Each worker's enter must be followed immediately by its own exit
    // before any other worker enters. If mutex works, the log is a
    // concatenation of paired enter/exit tokens.
    expect(log.length).toBe(6);
    for (let i = 0; i < log.length; i += 2) {
      const [enterId, enterTag] = log[i].split(":");
      const [exitId, exitTag] = log[i + 1].split(":");
      expect(enterTag).toBe("enter");
      expect(exitTag).toBe("exit");
      expect(enterId).toBe(exitId);
    }
  });

  test("FIFO fairness — waiters run in the order they called", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    const gate = deferred<void>();

    // First caller holds the lock until `gate` resolves.
    const first = mutex.withLock(async () => {
      order.push(0);
      await gate.promise;
    });

    // Queue three waiters in strict order.
    const waiters: Promise<void>[] = [];
    for (let i = 1; i <= 3; i++) {
      waiters.push(
        mutex.withLock(async () => {
          order.push(i);
        }),
      );
      // Tiny yield so each `acquire` lands before the next — otherwise
      // microtask ordering could interleave them.
      await Promise.resolve();
    }

    // Release the first lock. The queued waiters should run in FIFO.
    gate.resolve();
    await first;
    await Promise.all(waiters);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  test("releases the lock even when the callback throws", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.withLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Second call must succeed — the mutex must not be poisoned.
    const result = await mutex.withLock(async () => 42);
    expect(result).toBe(42);
    expect(mutex.isHeld).toBe(false);
    expect(mutex.waiting).toBe(0);
  });

  test("propagates the callback's return value", async () => {
    const mutex = new AsyncMutex();
    const value = await mutex.withLock(async () => ({ answer: 42 }));
    expect(value).toEqual({ answer: 42 });
  });
});

describe("KeyedMutex", () => {
  test("different keys run concurrently (no deadlock, no cross-blocking)", async () => {
    const keyed = new KeyedMutex<string>();
    const log: string[] = [];
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    // Task A holds key "a" and waits for gateA.
    const taskA = keyed.withLock("a", async () => {
      log.push("a:enter");
      await gateA.promise;
      log.push("a:exit");
    });

    // Task B holds key "b" — must be able to proceed even while A is held.
    const taskB = keyed.withLock("b", async () => {
      log.push("b:enter");
      await gateB.promise;
      log.push("b:exit");
    });

    // Wait until both tasks have entered. If keyed mutex were global, B
    // would be blocked behind A and this would time out.
    await new Promise((r) => setTimeout(r, 50));
    expect(log).toContain("a:enter");
    expect(log).toContain("b:enter");

    // Release both, in reverse order, and both tasks finish.
    gateB.resolve();
    gateA.resolve();
    await Promise.all([taskA, taskB]);

    expect(log).toContain("a:exit");
    expect(log).toContain("b:exit");
  });

  test("same key serializes", async () => {
    const keyed = new KeyedMutex<string>();
    const order: string[] = [];

    async function worker(tag: string, delay: number) {
      await keyed.withLock("shared", async () => {
        order.push(`${tag}:in`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${tag}:out`);
      });
    }

    await Promise.all([worker("a", 15), worker("b", 5)]);
    expect(order.length).toBe(4);
    // The two inner sections must be non-overlapping.
    for (let i = 0; i < order.length; i += 2) {
      const [tag1, kind1] = order[i].split(":");
      const [tag2, kind2] = order[i + 1].split(":");
      expect(kind1).toBe("in");
      expect(kind2).toBe("out");
      expect(tag1).toBe(tag2);
    }
  });

  test("tracks distinct keys", async () => {
    const keyed = new KeyedMutex<string>();
    await keyed.withLock("x", async () => {});
    await keyed.withLock("y", async () => {});
    await keyed.withLock("x", async () => {});
    expect(keyed.size).toBe(2);
  });
});
