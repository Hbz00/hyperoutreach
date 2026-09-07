import { z } from "zod";

const errorSchema = z.object({
  error: z.object({ code: z.string().max(128).optional() }).optional(),
});

const MAX_GRAPH_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_GRAPH_ERROR_BYTES = 64 * 1024;

/** Limit decoded bytes, including chunked/compressed responses. Coalesce tiny
 * chunks so fragmentation cannot grow the retained array without bound. */
export async function readGraphJson(
  response: Response,
  signal: AbortSignal,
  limit: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader?.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let completed = false;
  try {
    signal.throwIfAborted();
    const advertised = response.headers.get("content-length");
    if (advertised && /^\d+$/.test(advertised) && Number(advertised) > limit) {
      throw new Error("Microsoft Graph response exceeds size limit");
    }
    const chunks: Buffer[] = [];
    let current = Buffer.allocUnsafe(Math.min(64 * 1024, limit));
    let used = 0;
    let total = 0;
    while (reader) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > limit)
        throw new Error("Microsoft Graph response exceeds size limit");
      let offset = 0;
      while (offset < value.byteLength) {
        const count = Math.min(
          current.length - used,
          value.byteLength - offset,
        );
        current.set(value.subarray(offset, offset + count), used);
        used += count;
        offset += count;
        if (used === current.length) {
          chunks.push(current);
          current = Buffer.allocUnsafe(Math.min(64 * 1024, limit));
          used = 0;
        }
      }
    }
    if (used) chunks.push(current.subarray(0, used));
    try {
      return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    } catch {
      // JSON.parse errors can include the provider's response text.
      throw new Error("Microsoft Graph returned invalid JSON");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!completed) cancel();
    reader?.releaseLock();
  }
}

export class GraphApiError extends Error {
  override readonly name = "GraphApiError";

  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super("Microsoft Graph request failed");
  }
}

type GraphClientOptions = {
  accessToken: () => Promise<string>;
  fetcher?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
};

export class MicrosoftGraphClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly trustedOrigin: string;
  private readonly trustedPathPrefix: string;

  constructor(private readonly options: GraphClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://graph.microsoft.com/v1.0";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    const base = new URL(this.baseUrl);
    this.trustedOrigin = base.origin;
    this.trustedPathPrefix = `${base.pathname.replace(/\/$/, "")}/`;
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: "GET", signal });
  }

  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  patch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      body: JSON.stringify(body),
      signal,
    });
  }

  delete(path: string, signal?: AbortSignal): Promise<void> {
    return this.request<void>(path, { method: "DELETE", signal });
  }

  postWithoutBody<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: "POST", signal });
  }

  async request<T>(
    path: string,
    init: RequestInit & { preferImmutableId?: boolean },
  ): Promise<T> {
    const url = this.resolveUrl(path);
    init.signal?.throwIfAborted();
    const token = await this.options.accessToken();
    init.signal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetcher(url, {
      ...init,
      redirect: "error",
      signal: requestSignal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(init.preferImmutableId === false
          ? {}
          : { Prefer: 'IdType="ImmutableId"' }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      let code: string | null = null;
      try {
        const parsed = errorSchema.safeParse(
          await readGraphJson(response, requestSignal, MAX_GRAPH_ERROR_BYTES),
        );
        code = parsed.success ? (parsed.data.error?.code ?? null) : null;
      } catch {
        // A local body timeout cannot erase HTTP status or Retry-After already
        // received. Explicit caller cancellation still takes precedence.
        init.signal?.throwIfAborted();
        code = null;
      }
      const retryAfter = response.headers.get("retry-after")?.trim();
      const observedAt = Date.now();
      const retrySeconds =
        retryAfter && /^\d+$/.test(retryAfter)
          ? Number(retryAfter)
          : retryAfter &&
              /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
                retryAfter,
              )
            ? Math.max(0, (Date.parse(retryAfter) - observedAt) / 1_000)
            : NaN;
      throw new GraphApiError(
        response.status,
        code,
        Number.isFinite(retrySeconds) &&
          Number.isFinite(new Date(observedAt + retrySeconds * 1_000).getTime())
          ? retrySeconds
          : null,
      );
    }
    if (response.status === 202 || response.status === 204) {
      void response.body?.cancel().catch(() => undefined);
      requestSignal.throwIfAborted();
      return undefined as T;
    }
    return (await readGraphJson(
      response,
      requestSignal,
      MAX_GRAPH_RESPONSE_BYTES,
    )) as T;
  }

  private resolveUrl(path: string): string {
    if (!path.startsWith("https://") && !path.startsWith("/")) {
      throw new Error("Microsoft Graph URL is not trusted");
    }
    const resolved = path.startsWith("https://")
      ? new URL(path)
      : new URL(`${this.baseUrl}${path}`);
    if (
      resolved.protocol !== "https:" ||
      resolved.origin !== this.trustedOrigin ||
      (!resolved.pathname.startsWith(this.trustedPathPrefix) &&
        resolved.pathname !== this.trustedPathPrefix.slice(0, -1)) ||
      resolved.username ||
      resolved.password
    ) {
      throw new Error("Microsoft Graph URL is not trusted");
    }
    return resolved.toString();
  }
}
