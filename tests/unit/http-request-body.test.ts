import { describe, expect, it, vi } from "vitest";

import {
  bodyErrorResponse,
  readLimitedFormData,
  readLimitedJson,
  readRequestBody,
} from "@/lib/http-request-body";

function request(body: ReadableStream<Uint8Array>, options: RequestInit = {}) {
  return new Request("http://operator.local", {
    method: "POST",
    body,
    duplex: "half",
    ...options,
  } as RequestInit);
}

describe("bounded request stream handling", () => {
  it("preserves reused transport buffers and multibyte JSON across one-byte fragments", async () => {
    const expected = { text: "Été 🌞 東京".repeat(1000) };
    const bytes = new TextEncoder().encode(JSON.stringify(expected));
    const reused = new Uint8Array(1);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          reused[0] = bytes[offset++]!;
          controller.enqueue(reused);
        },
      },
      { highWaterMark: 0 },
    );
    await expect(readLimitedJson(request(body), bytes.length)).resolves.toEqual(
      expected,
    );
  });

  it("uses actual streamed bytes when content-length understates them", async () => {
    const cancel = vi.fn();
    let calls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          calls += 1;
          controller.enqueue(new Uint8Array(4));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    await expect(
      readRequestBody(request(body, { headers: { "content-length": "1" } }), 7),
    ).rejects.toMatchObject({ status: 413 });
    expect(calls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels before pulling an already aborted request", async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { pull, cancel },
      { highWaterMark: 0 },
    );
    await expect(
      readRequestBody(request(body, { signal: AbortSignal.abort() }), 10),
    ).rejects.toMatchObject({ status: 400 });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["deadline", "caller"] as const)(
    "cancels a stalled read on %s without returning partial input",
    async (cause) => {
      const abort = new AbortController();
      const cancel = vi.fn();
      let close: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          close = () => {
            try {
              controller.close();
            } catch {
              /* Already cancelled. */
            }
          };
          controller.enqueue(new TextEncoder().encode("partial"));
        },
        cancel,
      });
      const sentinel = setTimeout(() => close?.(), 100);
      const callerTimer =
        cause === "caller" ? setTimeout(() => abort.abort(), 5) : undefined;
      try {
        await expect(
          readRequestBody(
            request(body, { signal: abort.signal }),
            100,
            cause === "deadline" ? 5 : 1000,
          ),
        ).rejects.toMatchObject({ status: cause === "deadline" ? 408 : 400 });
        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        clearTimeout(sentinel);
        clearTimeout(callerTimer);
        close?.();
      }
    },
  );

  it("preserves multipart boundaries and exact password whitespace", async () => {
    const form = new FormData();
    form.set("password", "  synthetic password \t");
    form.set("csrf", "synthetic-csrf");
    const input = new Request("http://operator.local", {
      method: "POST",
      body: form,
    });
    const result = await readLimitedFormData(input, 16 * 1024);
    expect(result.get("password")).toBe("  synthetic password \t");
    expect(result.get("csrf")).toBe("synthetic-csrf");
  });

  it("does not expose parser or stream exception text in HTTP errors", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("synthetic-secret-body-fragment"));
      },
    });
    let caught: unknown;
    try {
      await readLimitedJson(request(body), 100);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const response = bodyErrorResponse(caught, "Invalid notification payload");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid notification payload",
    });
  });
});
