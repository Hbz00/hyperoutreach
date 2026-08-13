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
