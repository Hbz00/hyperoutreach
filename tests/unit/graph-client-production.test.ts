import { describe, expect, it, vi } from "vitest";

import { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";
import { graphRetryDeadline } from "@/lib/microsoft/graph-retry";

function client(fetcher: typeof fetch, requestTimeoutMs = 1_000) {
  return new MicrosoftGraphClient({
    accessToken: async () => "synthetic-token",
    fetcher,
    requestTimeoutMs,
  });
}

describe("Graph HTTP response bounds", () => {
  it("cancels an unread body when the response arrives after cancellation", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(
      client(async () => {
        controller.abort();
        return new Response(body);
      }).get("/me", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid JSON body exactly at the 16 MiB response boundary", async () => {
    const json = '"' + "a".repeat(16 * 1024 * 1024 - 2) + '"';
    const result = await client(async () => new Response(json)).get<string>(
      "/me",
    );
    expect(result.length).toBe(16 * 1024 * 1024 - 2);
  });

  it("does not include malformed response text in parse errors", async () => {
    await expect(
      client(
        async () => new Response("synthetic-provider-secret-not-json"),
      ).get("/me"),
    ).rejects.toMatchObject({
      message: "Microsoft Graph returned invalid JSON",
    });
  });

  it("stops and cancels an oversized streamed JSON response before draining it", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) controller.enqueue(new TextEncoder().encode('"'));
        else if (reads <= 20)
          controller.enqueue(new Uint8Array(1024 * 1024).fill(65));
        else {
          controller.enqueue(new TextEncoder().encode('"'));
          controller.close();
        }
      },
      cancel,
    });
    await expect(
      client(async () => new Response(body)).get("/me"),
    ).rejects.toThrow("Microsoft Graph response exceeds size limit");
    expect(reads).toBeLessThan(20);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized advertised length without reading the body", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    await expect(
      client(
        async () =>
          new Response(body, { headers: { "content-length": "999999999" } }),
      ).get("/me"),
    ).rejects.toThrow("Microsoft Graph response exceeds size limit");
    expect(pulls).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds error bodies while retaining status and retry delay", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1)
          controller.enqueue(new TextEncoder().encode('{"error":{"code":"'));
        else if (reads <= 10)
          controller.enqueue(new Uint8Array(64 * 1024).fill(65));
        else {
          controller.enqueue(new TextEncoder().encode('"}}'));
          controller.close();
        }
      },
      cancel,
    });
    await expect(
      client(
        async () =>
          new Response(body, {
            status: 429,
            headers: { "retry-after": "3600" },
          }),
      ).get("/me"),
    ).rejects.toMatchObject({
      name: "GraphApiError",
      status: 429,
      retryAfterSeconds: 3600,
      code: null,
    });
    expect(reads).toBeLessThan(5);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 429, callerSignal: false },
    { status: 429, callerSignal: true },
    { status: 503, callerSignal: false },
    { status: 503, callerSignal: true },
  ])(
    "retains $status Retry-After when the error body times out (caller signal: $callerSignal)",
    async ({ status, callerSignal }) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const controller = new AbortController();
      // AbortSignal.timeout does not keep Node alive on its own.
      const sentinel = setTimeout(() => undefined, 1_000);
      try {
        const error = await client(
          async () =>
            new Response(body, {
              status,
              headers: { "retry-after": "180" },
            }),
          10,
        )
          .get("/me", callerSignal ? controller.signal : undefined)
          .catch((error: unknown) => error);
        expect(error).toMatchObject({
          name: "GraphApiError",
          status,
          code: null,
          retryAfterSeconds: 180,
        });
        const now = new Date("2026-09-07T00:00:00.000Z");
        expect(graphRetryDeadline(error, now, 60_000).getTime()).toBe(
          now.getTime() + 180_000,
        );
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(controller.signal.aborted).toBe(false);
        expect(body.locked).toBe(false);
      } finally {
        clearTimeout(sentinel);
      }
    },
    1_000,
  );

  it("preserves a timeout cancellation supplied by the caller", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Caller deadline expired", "TimeoutError");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          controller.abort(reason);
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    await expect(
      client(
        async () =>
          new Response(body, {
            status: 503,
            headers: { "retry-after": "180" },
          }),
      ).get("/me", controller.signal),
    ).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("parses fragmented multibyte UTF-8 correctly", async () => {
    const expected = { value: "Été 🌞 東京".repeat(1000) };
    const bytes = new TextEncoder().encode(JSON.stringify(expected));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < bytes.length)
          controller.enqueue(bytes.subarray(offset, ++offset));
        else controller.close();
      },
    });
    await expect(
      client(async () => new Response(body)).get("/me"),
    ).resolves.toEqual(expected);
  });

  it("cancels a stalled response body when its request deadline expires", async () => {
    const cancel = vi.fn();
    let bodyCreated = false;
    let release: (() => void) | undefined;
    const sentinel = setTimeout(() => release?.(), 100);
    const result = client(async () => {
      bodyCreated = true;
      return new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              try {
                controller.close();
              } catch {
                /* Already cancelled. */
              }
            };
          },
          cancel,
        }),
      );
    }, 10).get("/me");
    try {
      await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
      expect(bodyCreated).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(sentinel);
      release?.();
    }
  }, 1_000);

  it("does not turn body cancellation into a retryable Graph HTTP error", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const sentinel = setTimeout(() => release?.(), 100);
    const body = new ReadableStream<Uint8Array>(
      {
        start(stream) {
          release = () => {
            try {
              stream.close();
            } catch {
              /* Already cancelled. */
            }
          };
        },
        pull() {
          controller.abort();
        },
      },
      { highWaterMark: 0 },
    );
    try {
      await expect(
        client(async () => new Response(body, { status: 503 })).get(
          "/me",
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(sentinel);
      release?.();
    }
  }, 1_000);
});

describe("Graph request authorization and redirect boundaries", () => {
  it("refuses a pre-aborted call before reading credentials", async () => {
    const accessToken = vi.fn(async () => "synthetic-token");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    await expect(
      new MicrosoftGraphClient({ accessToken, fetcher }).get(
        "/me",
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not fetch after cancellation during credential acquisition", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const graph = new MicrosoftGraphClient({
      accessToken: async () => {
        controller.abort();
        return "synthetic-token";
      },
      fetcher,
    });
    await expect(graph.get("/me", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires the HTTP transport to refuse redirects, including caller overrides", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const graph = client(fetcher);
    await graph.request("/me", { method: "GET", redirect: "follow" });
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe("error");
  });
});
