class Semaphore {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(
    timeoutMs: number,
    operation: (remainingMs: () => number) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    await this.acquire(deadline);
    try {
      if (deadline <= Date.now()) throw new CodexConcurrencyTimeoutError();
      return await operation(() => Math.max(0, deadline - Date.now()));
    } finally {
      this.release();
    }
  }

  private acquire(deadline: number): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        reject(new CodexConcurrencyTimeoutError());
        return;
      }
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index === -1) return;
          this.waiting.splice(index, 1);
          reject(new CodexConcurrencyTimeoutError());
        }, remainingMs),
      };
      this.waiting.push(waiter);
    });
  }

  private release() {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}

type Waiter = {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexConcurrencyTimeoutError extends Error {
  override readonly name = "CodexConcurrencyTimeoutError";
}

export class CodexConcurrencyConfigurationError extends Error {
  override readonly name = "CodexConcurrencyConfigurationError";
}

let sharedSemaphore: Semaphore | null = null;
let sharedConcurrency: number | null = null;

export function getSharedCodexSemaphore(maxConcurrency: number): Semaphore {
  if (sharedSemaphore) {
    if (sharedConcurrency !== maxConcurrency) {
      throw new CodexConcurrencyConfigurationError(
        "Conflicting process-wide Codex concurrency configuration",
      );
    }
    return sharedSemaphore;
  }
  sharedConcurrency = maxConcurrency;
  sharedSemaphore = new Semaphore(maxConcurrency);
  return sharedSemaphore;
}
