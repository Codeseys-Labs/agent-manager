/**
 * Async locking primitives for serializing business-level read-modify-write
 * operations across concurrent callers (Wave B of iter4 fix pass).
 *
 * These are in-process only — they do not serialize across OS processes.
 * Multi-process safety would require a file lock (`proper-lockfile`) on top.
 *
 * Design:
 *   - `AsyncMutex.withLock(fn)` runs `fn` when no other holder has the lock.
 *   - Waiters are released in FIFO order (fair queue).
 *   - Exceptions thrown by `fn` do NOT poison the mutex — the next waiter
 *     still runs.
 *   - `KeyedMutex<K>` holds one `AsyncMutex` per key so independent resources
 *     (e.g. two different config paths) don't block each other.
 *
 * See `docs/reviews/2026-04-17-iter4-system-critique/03-parallel-tool-calling.md`
 * for the hazard analysis that motivated this module.
 */

/**
 * A minimal fair async mutex. Exactly one `withLock` callback runs at a time
 * per instance; subsequent callers queue in FIFO order.
 */
export class AsyncMutex {
  private queue: Array<() => void> = [];
  private held = false;

  /**
   * Acquire the lock, run `fn`, and release. Waiters are served in FIFO.
   * If `fn` throws, the rejection propagates to the caller and the lock is
   * still released so the next waiter can proceed.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Returns true if the mutex is currently held. Diagnostic only. */
  get isHeld(): boolean {
    return this.held;
  }

  /** Number of callers currently waiting. Diagnostic only. */
  get waiting(): number {
    return this.queue.length;
  }

  private acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the lock directly to the next waiter without releasing `held`.
      // This keeps the invariant that exactly one holder exists at any time.
      next();
    } else {
      this.held = false;
    }
  }
}

/**
 * A keyed mutex: one `AsyncMutex` per key. Useful when you want per-resource
 * serialization rather than a global bottleneck — e.g. one lock per config
 * directory.
 *
 * Memory: the per-key mutexes are retained for the lifetime of the
 * `KeyedMutex`. For short-lived keys this can leak; callers with unbounded
 * key sets should consider eviction.
 */
export class KeyedMutex<K> {
  private map = new Map<K, AsyncMutex>();

  async withLock<T>(key: K, fn: () => Promise<T>): Promise<T> {
    let mutex = this.map.get(key);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.map.set(key, mutex);
    }
    return mutex.withLock(fn);
  }

  /** Number of distinct keys tracked. Diagnostic only. */
  get size(): number {
    return this.map.size;
  }
}
