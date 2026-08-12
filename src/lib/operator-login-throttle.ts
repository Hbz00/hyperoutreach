type FailureWindow = { count: number; expiresAt: number };

export class OperatorLoginThrottle {
  private readonly failures = new Map<string, FailureWindow>();

  constructor(
    private readonly options: { limit: number; windowMs: number } = {
      limit: 8,
      windowMs: 15 * 60_000,
    },
  ) {}

  check(
    source: string,
    now = new Date(),
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const current = this.failures.get(source);
    if (!current || current.expiresAt <= now.getTime()) {
      this.failures.delete(source);
      return { allowed: true };
    }
    if (current.count < this.options.limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((current.expiresAt - now.getTime()) / 1_000),
      ),
    };
  }

  recordFailure(source: string, now = new Date()): void {
    const timestamp = now.getTime();
    const current = this.failures.get(source);
    this.failures.set(source, {
      count: current && current.expiresAt > timestamp ? current.count + 1 : 1,
      expiresAt:
        current && current.expiresAt > timestamp
          ? current.expiresAt
          : timestamp + this.options.windowMs,
    });
    if (this.failures.size > 5_000) this.prune(timestamp);
  }

  recordSuccess(source: string): void {
    this.failures.delete(source);
  }

  private prune(now: number): void {
    for (const [source, failure] of this.failures) {
      if (failure.expiresAt <= now) this.failures.delete(source);
    }
    if (this.failures.size > 5_000) {
      const oldest = this.failures.keys().next().value as string | undefined;
      if (oldest) this.failures.delete(oldest);
    }
  }
}
