import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { reconcileInboundMailbox, createCountingIngest, defaultInboundNaming } =
  await import("@/modules/mailboxes/inbound-reconciliation");

type IngestPage = (messages: unknown[]) => Promise<number>;

/** A source that publishes the given pages one after the other. */
function pagedSource(
  pages: unknown[][],
  result: { nextCursor: string; rebaselined?: boolean },
) {
  return {
    kind: "smtp_imap" as const,
    fetchSince: async (_cursor: string | null, ingestPage: IngestPage) => {
      for (const page of pages) await ingestPage(page);
      return {
        nextCursor: result.nextCursor,
        rebaselined: result.rebaselined ?? false,
      };
    },
  };
}

describe("cancelling an inbound round", () => {
  it.each(["before-load", "after-load", "empty-fetch", "last-ingest"])(
    "refuses cursor success when cancelled at %s",
    async (boundary) => {
      const controller = new AbortController();
      const saveCursor = vi.fn();
      const loadCursor = vi.fn(async () => {
        if (boundary === "after-load") controller.abort();
        return "1:0";
      });
      const ingest = vi.fn(async () => {
        controller.abort();
        return { ok: true, disposition: "processed" };
      });
      const fetchSince = vi.fn(
        async (_cursor: string | null, ingestPage: IngestPage) => {
          if (boundary === "last-ingest") {
            await ingestPage([{ providerMessageId: "uid-1" }]);
          } else {
            controller.abort();
          }
          return { nextCursor: "1:1", rebaselined: false };
        },
      );
      if (boundary === "before-load") controller.abort();
      await expect(
        reconcileInboundMailbox(
          { mailboxId: "mbx-1", source: { kind: "smtp_imap", fetchSince } },
          { loadCursor, saveCursor, ingest, signal: controller.signal },
        ),
      ).rejects.toThrow(/abort/i);
      expect(saveCursor).not.toHaveBeenCalled();
      if (boundary === "before-load") expect(loadCursor).not.toHaveBeenCalled();
      if (boundary === "before-load" || boundary === "after-load") {
        expect(fetchSince).not.toHaveBeenCalled();
      }
      if (boundary === "last-ingest") expect(ingest).toHaveBeenCalledTimes(1);
    },
  );

  /**
   * The stage deadline can only end a round the round agrees to end.
   *
   * A maintenance stage that outruns its budget is now abandoned, and an
   * abandoned round that keeps running keeps its advisory lock — which is the
   * twenty-eight-minute wedge, moved rather than fixed. The signal has to reach
   * the work: down to the IMAP calls, which already accept one, and to the
   * ingest loop here, which is where a wedged classifier or a slow write would
   * hang instead.
   */
  it("hands the source the signal it was given", async () => {
    const controller = new AbortController();
    const fetchSince = vi.fn(
      async (_cursor: string | null, ingestPage: IngestPage) => {
        await ingestPage([{ providerMessageId: "uid-1" }]);
        return { nextCursor: "1:1", rebaselined: false };
      },
    );

    await reconcileInboundMailbox(
      { source: { kind: "smtp_imap", fetchSince }, mailboxId: "mbx-1" },
      {
        loadCursor: async () => null,
        saveCursor: vi.fn(),
        ingest: vi
          .fn()
          .mockResolvedValue({ ok: true, disposition: "processed" }),
        signal: controller.signal,
      },
    );

    expect(fetchSince).toHaveBeenCalledWith(null, expect.any(Function), {
      signal: controller.signal,
    });
  });

  it("stops ingesting a page once the round is aborted", async () => {
    // The hang this covers is not in IMAP: the transport handed over a page and
    // the work stalled on the messages themselves. Checked per message rather
    // than per page, because a page is up to fifty of them.
    const controller = new AbortController();
    const ingest = vi.fn(async () => {
      controller.abort();
      return { ok: true, disposition: "processed" } as const;
    });
    const saveCursor = vi.fn();

    await expect(
      reconcileInboundMailbox(
        {
          source: {
            kind: "smtp_imap",
            fetchSince: async (
              _cursor: string | null,
              ingestPage: IngestPage,
            ) => {
              await ingestPage([
                { providerMessageId: "uid-1" },
                { providerMessageId: "uid-2" },
              ]);
              return { nextCursor: "1:2", rebaselined: false };
            },
          },
          mailboxId: "mbx-1",
        },
        {
          loadCursor: async () => null,
          saveCursor,
          ingest,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow(/abort/i);

    expect(ingest).toHaveBeenCalledTimes(1);
    // A cancelled round must not advance the cursor: the messages it did not
    // reach have to be walked again next time.
    expect(saveCursor).not.toHaveBeenCalled();
  });
});

describe("shared inbound reconciliation", () => {
  it("advances the cursor and ingests every returned message", async () => {
    const fetchSince = vi.fn(
      async (_cursor: string | null, ingestPage: IngestPage) => {
        await ingestPage([{ providerMessageId: "uid-1" }]);
        return { nextCursor: "1:42", rebaselined: false };
      },
    );
    const ingest = vi
      .fn()
      .mockResolvedValue({ ok: true, disposition: "processed" });
    const saveCursor = vi.fn();

    const result = await reconcileInboundMailbox(
      { source: { kind: "smtp_imap", fetchSince }, mailboxId: "mbx-1" },
      { loadCursor: async () => null, saveCursor, ingest },
    );

    expect(fetchSince).toHaveBeenCalledWith(null, expect.any(Function));
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(result.nextCursor).toBe("1:42");
    expect(saveCursor).toHaveBeenCalledWith("mbx-1", "1:42", false);
  });

  it("propagates the rebaseline flag", async () => {
    const result = await reconcileInboundMailbox(
      {
        source: pagedSource([[]], { nextCursor: "2:0", rebaselined: true }),
        mailboxId: "mbx-1",
      },
      { loadCursor: async () => "1:9", saveCursor: vi.fn(), ingest: vi.fn() },
    );
    expect(result.rebaselined).toBe(true);
  });

  it("hands the stored cursor to the source", async () => {
    const fetchSince = vi.fn(async () => ({
      nextCursor: "3:7",
      rebaselined: false,
    }));
    await reconcileInboundMailbox(
      { source: { kind: "smtp_imap", fetchSince }, mailboxId: "mbx-1" },
      { loadCursor: async () => "3:1", saveCursor: vi.fn(), ingest: vi.fn() },
    );
    expect(fetchSince).toHaveBeenCalledWith("3:1", expect.any(Function));
  });

  it("keeps earlier pages ingested when a later page fails", async () => {
    const ingested: unknown[] = [];
    const saveCursor = vi.fn();
    await expect(
      reconcileInboundMailbox(
        {
          source: {
            kind: "smtp_imap",
            fetchSince: async (_cursor, ingestPage) => {
              await ingestPage([{ id: "page-1" }]);
              throw new Error("connection reset while paging");
            },
          },
          mailboxId: "mbx-1",
        },
        {
          loadCursor: async () => null,
          saveCursor,
          ingest: async (message) => {
            ingested.push(message);
            return { ok: true, disposition: "processed" };
          },
        },
      ),
    ).rejects.toThrow("connection reset while paging");
    expect(ingested).toEqual([{ id: "page-1" }]);
    expect(saveCursor).not.toHaveBeenCalled();
  });

  it("reports each page count to the source and cumulates the round", async () => {
    const counts: number[] = [];
    const result = await reconcileInboundMailbox(
      {
        source: {
          kind: "smtp_imap",
          fetchSince: async (_cursor, ingestPage) => {
            counts.push(await ingestPage([{ id: "a" }, { id: "b" }]));
            counts.push(await ingestPage([{ id: "c" }]));
            return { nextCursor: "1:50", rebaselined: false };
          },
        },
        mailboxId: "mbx-1",
      },
      {
        loadCursor: async () => null,
        saveCursor: vi.fn(),
        ingest: async (message) => ({
          ok: true,
          disposition:
            (message as { id: string }).id === "b" ? "existing" : "processed",
        }),
      },
    );
    expect(counts).toEqual([1, 1]);
    expect(result.processed).toBe(2);
  });

  it("does not advance the cursor when ingestion is not durable", async () => {
    const saveCursor = vi.fn();
    await expect(
      reconcileInboundMailbox(
        {
          source: pagedSource([[{ providerMessageId: "uid-1" }]], {
            nextCursor: "1:42",
          }),
          mailboxId: "mbx-1",
        },
        {
          loadCursor: async () => null,
          saveCursor,
          ingest: async () => ({ ok: false, code: "CLASSIFIER_ERROR" }),
        },
      ),
    ).rejects.toThrow("Inbound delta processing not completed");
    expect(saveCursor).not.toHaveBeenCalled();
  });

  it("tolerates an in-progress ingestion and does not count it", async () => {
    const saveCursor = vi.fn();
    const result = await reconcileInboundMailbox(
      {
        source: pagedSource([[{ providerMessageId: "uid-1" }]], {
          nextCursor: "1:43",
        }),
        mailboxId: "mbx-1",
      },
      {
        loadCursor: async () => null,
        saveCursor,
        ingest: async () => ({ ok: false, code: "IN_PROGRESS" }),
      },
    );
    expect(result.processed).toBe(0);
    expect(saveCursor).toHaveBeenCalledWith("mbx-1", "1:43", false);
  });

  it("does not count messages already ingested by another round", async () => {
    const result = await reconcileInboundMailbox(
      {
        source: pagedSource([[{ id: "a" }, { id: "b" }]], {
          nextCursor: "1:44",
        }),
        mailboxId: "mbx-1",
      },
      {
        loadCursor: async () => null,
        saveCursor: vi.fn(),
        ingest: async (message) => ({
          ok: true,
          disposition:
            (message as { id: string }).id === "a" ? "existing" : "processed",
        }),
      },
    );
    expect(result.processed).toBe(1);
  });

  it("tallies the same count the round reports, for the audit payload", async () => {
    const counted = createCountingIngest(async (message) => ({
      ok: true,
      disposition:
        (message as { id: string }).id === "a" ? "existing" : "processed",
    }));
    const result = await reconcileInboundMailbox(
      {
        source: pagedSource([[{ id: "a" }], [{ id: "b" }, { id: "c" }]], {
          nextCursor: "1:45",
        }),
        mailboxId: "mbx-1",
      },
      {
        loadCursor: async () => null,
        saveCursor: async () => {
          // the writer reads the tally while the round is still running
          expect(counted.processed()).toBe(2);
        },
        ingest: counted.ingest,
      },
    );
    expect(counted.processed()).toBe(result.processed);
  });

  it("derives provider neutral names for a mailbox round", () => {
    expect(defaultInboundNaming("smtp_imap", "mbx-1")).toMatchObject({
      lockKey: "inbound-delta:smtp_imap:mbx-1",
      healthKey: "smtp_imap:inbound-health:mbx-1",
      event: "smtp_imap.inbound_failed",
      workflowName: "inbound_reconciliation",
    });
  });
});
