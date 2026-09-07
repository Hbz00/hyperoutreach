import { describe, expect, it, vi } from "vitest";

import {
  GraphApiError,
  MicrosoftGraphClient,
} from "@/lib/microsoft/graph-client";
import { createMicrosoftGraphInboundSource } from "@/modules/mailboxes/microsoft-graph-inbound-source";

const cursor = "https://graph.microsoft.com/v1.0/delta-start";
const next = "https://graph.microsoft.com/v1.0/delta-next";
const final = "https://graph.microsoft.com/v1.0/delta-final";
const message = {
  id: "reply",
  subject: "Re: Hello",
  receivedDateTime: "2026-09-05T10:00:00.000Z",
  from: { emailAddress: { address: "prospect@example.org" } },
  toRecipients: [{ emailAddress: { address: "operator@example.org" } }],
  body: { contentType: "text", content: "Please stop" },
};

function source(fetcher: typeof fetch) {
  return createMicrosoftGraphInboundSource(
    new MicrosoftGraphClient({
      accessToken: async () => "synthetic-test-token",
      fetcher,
    }),
    { id: "mailbox", since: new Date("2026-09-01T00:00:00.000Z") },
  );
}

describe("Graph delta cursor and cancellation boundaries", () => {
  it("refuses a malformed nonremoved message without returning a cursor or ingesting a partial page, then replays after correction", async () => {
    let corrected = false;
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        value: [message, ...(corrected ? [] : [{ id: "bad", subject: 42 }])],
        "@odata.deltaLink": final,
      }),
    );
    const inbound = source(fetcher);
    const ingest = vi.fn(async (messages: unknown[]) => messages.length);
    await expect(inbound.fetchSince(cursor, ingest)).rejects.toThrow(
      "Microsoft Graph delta contains an invalid message",
    );
    expect(ingest).not.toHaveBeenCalled();
    corrected = true;
    await expect(inbound.fetchSince(cursor, ingest)).resolves.toEqual({
      nextCursor: final,
      rebaselined: false,
    });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0]).toHaveLength(1);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([cursor, cursor]);
  });

  it("accepts deletion tombstones without discarding valid messages", async () => {
    const ingest = vi.fn(async (messages: unknown[]) => messages.length);
    await expect(
      source(async () =>
        Response.json({
          value: [
            { id: "deleted", "@removed": { reason: "deleted" } },
            message,
          ],
          "@odata.deltaLink": final,
        }),
      ).fetchSince(cursor, ingest),
    ).resolves.toMatchObject({ nextCursor: final });
    expect(ingest.mock.calls[0]![0]).toHaveLength(1);
  });

  it("does not fetch when the round is already aborted", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ value: [], "@odata.deltaLink": final }),
    );
    const ingest = vi.fn(async () => 0);
    await expect(
      source(fetcher).fetchSince(cursor, ingest, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("passes cancellation to an in-flight HTTP request", async () => {
    const controller = new AbortController();
    const ingest = vi.fn(async () => 0);
    let httpSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      httpSignal = init?.signal;
      controller.abort();
      // A fetch implementation observes the supplied request signal.
      if (httpSignal?.aborted) throw httpSignal.reason;
      return Response.json({ value: [message], "@odata.deltaLink": final });
    };
    await expect(
      source(fetcher).fetchSince(cursor, ingest, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(httpSignal?.aborted).toBe(true);
    expect(ingest).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "does not fetch another page or return a cursor after ingestion aborts (hasNext=%s)",
    async (hasNext) => {
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({
          value: [message],
          ...(hasNext
            ? { "@odata.nextLink": next }
            : { "@odata.deltaLink": final }),
        }),
      );
      const ingest = vi.fn(async () => {
        controller.abort();
        return 1;
      });
      // The sentinel prevents the unfixed source's endless pagination from hanging the harness.
      fetcher
        .mockImplementationOnce(async () =>
          Response.json({
            value: [message],
            ...(hasNext
              ? { "@odata.nextLink": next }
              : { "@odata.deltaLink": final }),
          }),
        )
        .mockImplementation(async () => {
          throw new Error("Unexpected second request");
        });
      await expect(
        source(fetcher).fetchSince(cursor, ingest, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(ingest).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a repeated continuation before refetching the same page", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ value: [message], "@odata.nextLink": next }),
      )
      .mockResolvedValueOnce(
        Response.json({ value: [message], "@odata.nextLink": next }),
      )
      .mockRejectedValue(new Error("Unexpected repeated request"));
    const ingest = vi.fn(async () => 1);
    await expect(source(fetcher).fetchSince(cursor, ingest)).rejects.toThrow(
      "Microsoft Graph delta repeated a continuation URL",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it("allows the initial URL again for the single expired-token rebaseline", async () => {
    let initialUrl: string | undefined;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (fetcher.mock.calls.length === 1) {
        initialUrl = String(url);
        throw new GraphApiError(410, "syncStateNotFound", null);
      }
      expect(String(url)).toBe(initialUrl);
      return Response.json({ value: [message], "@odata.deltaLink": final });
    });
    await expect(
      source(fetcher).fetchSince(null, async () => 1),
    ).resolves.toEqual({ nextCursor: final, rebaselined: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
