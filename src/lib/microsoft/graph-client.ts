import { z } from "zod";

const errorSchema = z.object({
  error: z.object({ code: z.string().optional() }).optional(),
});

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
    const token = await this.options.accessToken();
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetcher(url, {
      ...init,
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
        const parsed = errorSchema.safeParse(await response.json());
        code = parsed.success ? (parsed.data.error?.code ?? null) : null;
      } catch {
        code = null;
      }
      const retryAfter = response.headers.get("retry-after");
      throw new GraphApiError(
        response.status,
        code,
        retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null,
      );
    }
    if (response.status === 202 || response.status === 204)
      return undefined as T;
    return (await response.json()) as T;
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
