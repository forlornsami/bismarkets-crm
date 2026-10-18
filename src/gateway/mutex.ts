// One write at a time per MT5 login. The balance operation searches MT5 for
// its own comment before it sends, and that search only proves anything if no
// other write on the same login can run between the search and the send. So
// the lock covers both, and anything else that writes to the login.

export class LockTimeout extends Error {}

export class KeyedMutex {
  // A key is present while someone holds it; its array is the queue of waiters.
  private queues = new Map<string, Array<() => void>>();

  /** Runs `fn` holding the key. Waiting longer than `waitMs` throws LockTimeout without running it. */
  async run<T>(key: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
    await this.acquire(key, waitMs);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  /** Keys held or waited on now (bounded by the requests in flight). */
  get size() {
    return this.queues.size;
  }

  private acquire(key: string, waitMs: number): Promise<void> {
    const queue = this.queues.get(key);
    if (!queue) {
      this.queues.set(key, []);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const at = queue.indexOf(grant);
        if (at >= 0) queue.splice(at, 1);
        reject(new LockTimeout(`waited more than ${waitMs} ms for ${key}`));
      }, Math.max(0, waitMs));
      queue.push(grant);
    });
  }

  private release(key: string) {
    const queue = this.queues.get(key);
    const next = queue?.shift();
    // The lock passes straight to the next waiter, so nobody can slip in between.
    if (next) next();
    else this.queues.delete(key);
  }
}
