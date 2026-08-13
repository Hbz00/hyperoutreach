import { describe, expect, it } from "vitest";

import { extractMessageId } from "@/lib/smtp-imap/mime";
import { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";
import type {
  ImapFetchedMessage,
  ImapFolderRole,
  ImapFolderRoles,
  ImapPort,
} from "@/lib/smtp-imap/imap-client";
import type {
  SmtpEnvelope,
  SmtpPort,
  SmtpSubmitResult,
} from "@/lib/smtp-imap/smtp-client";
import type {
  MailDraftInput,
  MailProvider,
  MailProviderKind,
} from "@/modules/mailboxes/mail-provider";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { MicrosoftGraphMailProvider } from "@/modules/mailboxes/microsoft-graph-mail-provider";
import {
  SmtpImapMailProvider,
  type SendJournal,
  type SmtpRejectionDetails,
} from "@/modules/mailboxes/smtp-imap-mail-provider";

/**
 * Task 14's shared contract suite: the same three properties, proven
 * identically against all three `MailProvider` implementations. Every
 * provider is built with its own test double — the mock's in-memory state,
 * a fake Microsoft Graph HTTP client, and a fake IMAP/SMTP transport pair —
 * never against a real network. `deliveryCount()` counts *actual
 * deliveries the transport layer performed*, not `sendDraft` invocation
 * count: a provider that absorbs a repeated `sendDraft` without resubmitting
 * must show `1`, not `0` and not the number of calls made.
 */

const draftInput: MailDraftInput = {
  outreachId: "contract-outreach-1",
  mailboxId: "mbx-contract-1",
  sender: null,
  recipient: "prospect@contract.example",
  subject: "Contract subject",
  body: "Contract body",
  headers: {},
};

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

function makeMockProvider(): { provider: MailProvider; deliveries: unknown[] } {
  const provider = new MockMailProvider();
  return { provider, deliveries: provider.deliveries };
}

// ---------------------------------------------------------------------------
// microsoft_graph — a fake HTTP fetcher standing in for Microsoft Graph.
// ---------------------------------------------------------------------------

type FakeGraphDraft = {
  id: string;
  isDraft: boolean;
  internetMessageId: string;
  conversationId: string;
};

/**
 * The real `MicrosoftGraphMailProvider.createDraft` always POSTs — it has no
 * idempotency guard of its own (design doc: Graph's own immutable-id draft
 * creation is not natively idempotent). The contract's "stable draft id"
 * case is still required to hold for every provider (task brief, arbitrated
 * explicitly), so *this fake server* dedupes by the `X-Outreach-ID` header
 * the real provider already stamps on every draft — standing in for
 * whatever idempotency a real deployment would need in front of Graph, not
 * a change to the provider itself.
 *
 * `sendDraft`'s repeat-call behavior is the opposite: Graph has no
 * idempotency guard on `/send` either, and unlike `createDraft` this is not
 * papered over — the arbitrated brief requires the *second* send to be
 * rejected, mirroring the real server's behavior once a draft has been
 * converted into a sent message (its id is no longer an actionable draft).
 */
function makeGraphProviderWithFakeClient(): {
  provider: MailProvider;
  graphSendCalls: unknown[];
} {
  const graphSendCalls: Array<{ draftId: string }> = [];
  const draftIdByOutreachId = new Map<string, string>();
  const drafts = new Map<string, FakeGraphDraft>();
  let nextId = 0;

  const fetcher: typeof fetch = async (input, init = {}) => {
    // A custom fetcher (unlike the real global `fetch`) never rejects an
    // already-aborted signal on its own — this is what makes the contract's
    // "honours an aborted signal" case meaningful against a fake instead of
    // trivially passing regardless of what the provider does.
    if (init.signal?.aborted) {
      throw init.signal.reason instanceof Error
        ? init.signal.reason
        : new Error("aborted");
    }
    const url = String(input);
    const method = init.method ?? "GET";

    if (method === "POST" && url.endsWith("/me/messages")) {
      const body = JSON.parse(String(init.body)) as {
        internetMessageHeaders: Array<{ name: string; value: string }>;
      };
      const outreachId =
        body.internetMessageHeaders.find(
          (header) => header.name === "X-Outreach-ID",
        )?.value ?? `unkeyed-${nextId}`;
      const existingId = draftIdByOutreachId.get(outreachId);
      if (existingId) {
        return Response.json(drafts.get(existingId), { status: 201 });
      }
      nextId += 1;
      const id = `graph-draft-${nextId}`;
      const draft: FakeGraphDraft = {
        id,
        isDraft: true,
        internetMessageId: `<${id}@graph.contract.example>`,
        conversationId: `conversation-${id}`,
      };
      drafts.set(id, draft);
      draftIdByOutreachId.set(outreachId, id);
      return Response.json(draft, { status: 201 });
    }

    const sendMatch = /\/me\/messages\/([^/]+)\/send$/.exec(url);
    if (method === "POST" && sendMatch) {
      const id = decodeURIComponent(sendMatch[1]!);
      const draft = drafts.get(id);
      if (!draft || !draft.isDraft) {
        // Real Graph behavior once a draft has already been sent: the id no
        // longer names an actionable draft, so a second `/send` is refused.
        return Response.json(
          {
            error: {
              code: "ErrorInvalidRequest",
              message: "message is not a draft",
            },
          },
          { status: 404 },
        );
      }
      draft.isDraft = false;
      graphSendCalls.push({ draftId: id });
      return new Response(null, { status: 202 });
    }

    const getMatch = /\/me\/messages\/([^/?]+)/.exec(url);
    if (method === "GET" && getMatch) {
      const id = decodeURIComponent(getMatch[1]!);
      const draft = drafts.get(id);
      if (!draft) return Response.json({ error: {} }, { status: 404 });
      return Response.json(draft, { status: 200 });
    }

    throw new Error(`unexpected fake Graph request: ${method} ${url}`);
  };

  const client = new MicrosoftGraphClient({
    accessToken: async () => "fake-graph-token",
    fetcher,
  });
  return {
    provider: new MicrosoftGraphMailProvider(client, "mbx-contract-1"),
    graphSendCalls,
  };
}

// ---------------------------------------------------------------------------
// smtp_imap — a fake IMAP/SMTP transport pair, real SmtpImapMailProvider.
// ---------------------------------------------------------------------------

type StoredImapMessage = {
  uid: number;
  mime: string;
  messageId: string | null;
};

function unexpectedImapCall(name: string): () => never {
  return () => {
    throw new Error(`unexpected fake ImapPort call: ${name}`);
  };
}

/** In-memory Drafts/Sent pair. Real UIDVALIDITY/UID bookkeeping, real
 * Message-ID indexed lookup — everything `SmtpImapMailProvider` itself
 * relies on is exercised for real; only the network is faked. */
class FakeImapTransport implements ImapPort {
  private readonly uidValidity = 5_000;
  private nextUid = 1;
  private readonly drafts = new Map<number, StoredImapMessage>();
  private readonly sent = new Map<number, StoredImapMessage>();

  async appendDraft(mime: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const uid = this.nextUid;
    this.nextUid += 1;
    this.drafts.set(uid, { uid, mime, messageId: extractMessageId(mime) });
    return { uidValidity: this.uidValidity, uid };
  }

  async findByMessageId(
    role: ImapFolderRole,
    messageId: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const folder = role === "drafts" ? this.drafts : this.sent;
    for (const message of folder.values()) {
      if (message.messageId === messageId) {
        return { uidValidity: this.uidValidity, uid: message.uid };
      }
    }
    return null;
  }

  async moveToSent(uidValidity: number, uid: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (uidValidity !== this.uidValidity) {
      throw new Error("UIDVALIDITY mismatch in fake IMAP transport");
    }
    const message = this.drafts.get(uid);
    if (!message) throw new Error(`fake IMAP: no draft at uid ${uid} to move`);
    this.drafts.delete(uid);
    this.sent.set(uid, message);
  }

  async fetchDraftSource(
    uidValidity: number,
    uid: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (uidValidity !== this.uidValidity) {
      throw new Error("UIDVALIDITY mismatch in fake IMAP transport");
    }
    const message = this.drafts.get(uid);
    if (!message) throw new Error(`fake IMAP: no draft at uid ${uid}`);
    return message.mime;
  }

  resolveFolders = unexpectedImapCall(
    "resolveFolders",
  ) as () => Promise<ImapFolderRoles>;
  status = unexpectedImapCall("status") as () => Promise<{
    uidValidity: number;
    uidNext: number;
  }>;
  findFirstUidSince = unexpectedImapCall("findFirstUidSince") as () => Promise<
    number | null
  >;
  fetchRange = (): AsyncGenerator<ImapFetchedMessage[]> => {
    throw new Error("unexpected fake ImapPort call: fetchRange");
  };
}

class FakeSmtpTransport implements SmtpPort {
  readonly submissions: Array<{ mime: string; envelope: SmtpEnvelope }> = [];

  async submit(
    mime: string,
    envelope: SmtpEnvelope,
    signal?: AbortSignal,
  ): Promise<SmtpSubmitResult> {
    signal?.throwIfAborted();
    this.submissions.push({ mime, envelope });
    return {
      messageId: extractMessageId(mime) ?? "<unknown>",
      response: "250 OK (fake)",
    };
  }

  async verify(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
  }
}

/** Same real release semantics as `WorkflowEventsSendJournal`, in memory —
 * matches the stateful `FakeSendJournal` already used by
 * `smtp-imap-provider-send.test.ts`/`smtp-imap-provider-reconcile.test.ts`. */
class FakeSendJournal implements SendJournal {
  async getPermanentRejection(): Promise<SmtpRejectionDetails | null> {
    return null;
  }
  private readonly attempted = new Set<string>();
  private readonly accepted = new Set<string>();

  async hasAttempt(messageKey: string): Promise<boolean> {
    return this.attempted.has(messageKey);
  }

  async hasAcceptance(messageKey: string): Promise<boolean> {
    return this.accepted.has(messageKey);
  }

  async recordAttempt(messageKey: string): Promise<boolean> {
    if (this.attempted.has(messageKey)) return false;
    this.attempted.add(messageKey);
    return true;
  }

  async recordAcceptance(messageKey: string): Promise<void> {
    this.accepted.add(messageKey);
  }

  async recordRejection(
    messageKey: string,
    rejection: SmtpRejectionDetails,
  ): Promise<void> {
    if (rejection.releaseAttempt) this.attempted.delete(messageKey);
  }
}

function makeSmtpProviderWithFakeTransport(): {
  provider: MailProvider;
  smtpSubmissions: unknown[];
} {
  const imap = new FakeImapTransport();
  const smtp = new FakeSmtpTransport();
  const provider = new SmtpImapMailProvider(
    imap,
    smtp,
    "mbx-contract-1",
    "operator@contract.example",
    new FakeSendJournal(),
  );
  return { provider, smtpSubmissions: smtp.submissions };
}

// ---------------------------------------------------------------------------
// The shared contract
// ---------------------------------------------------------------------------

// Reassigned by `makeProvider()` on every call, immediately before use —
// never read across two different `it()`s, so a fresh provider's fresh
// backing array is always what `deliveryCount()` reports for that test. This
// is correct only because `describe.each` below runs its cases and their
// `it()`s sequentially (this suite's default, and this file's own default —
// no `.concurrent` anywhere here): two `it()`s racing on the same module-level
// `let` would silently read each other's provider's array instead. Note this
// isn't fixable by "use a closure" -- the `providerCases` tuples below are
// already closures, and the module-level `let` is exactly how `deliveryCount`
// (a separately-called function) observes what `makeProvider` (a distinct
// call) just assigned; that's the coupling that needs the variable to be
// module-level in the first place. Making this safe under `.concurrent` would
// require restructuring `providerCases` so each case's `makeProvider` and
// `deliveryCount` close over one shared per-invocation state object returned
// together from a single factory call, instead of coordinating through a
// module-level `let`.
let mockDeliveries: unknown[] = [];
let graphSendCalls: unknown[] = [];
let smtpSubmissions: unknown[] = [];

const providerCases: Array<
  [MailProviderKind, () => Promise<MailProvider>, () => number]
> = [
  [
    "mock",
    async () => {
      const built = makeMockProvider();
      mockDeliveries = built.deliveries;
      return built.provider;
    },
    () => mockDeliveries.length,
  ],
  [
    "microsoft_graph",
    async () => {
      const built = makeGraphProviderWithFakeClient();
      graphSendCalls = built.graphSendCalls;
      return built.provider;
    },
    () => graphSendCalls.length,
  ],
  [
    "smtp_imap",
    async () => {
      const built = makeSmtpProviderWithFakeTransport();
      smtpSubmissions = built.smtpSubmissions;
      return built.provider;
    },
    () => smtpSubmissions.length,
  ],
];

describe.each(providerCases)(
  "%s satisfies the mail provider contract",
  (name, makeProvider, deliveryCount) => {
    // For `microsoft_graph`, this proves the fake server's own
    // `X-Outreach-ID` dedup is stable, not that `MicrosoftGraphMailProvider`
    // itself is idempotent -- it isn't (see `makeGraphProviderWithFakeClient`'s
    // own doc comment: the real provider always POSTs a new draft; nothing in
    // `microsoft-graph-mail-provider.ts` is touched or claimed idempotent
    // here). For `mock` and `smtp_imap`, this *does* exercise the real
    // provider's own idempotency (`MockMailProvider`'s keyed draft map,
    // `SmtpImapMailProvider`'s deterministic Message-ID lookup).
    it("returns a stable draft id across repeated createDraft calls", async () => {
      const provider = await makeProvider();
      const first = await provider.createDraft(draftInput);
      const second = await provider.createDraft(draftInput);
      expect(second.draftId).toBe(first.draftId);
    });

    it("never produces a second delivery on a repeated send", async () => {
      const provider = await makeProvider();
      const { draftId } = await provider.createDraft(draftInput);
      const send = () =>
        provider.sendDraft({
          draftId,
          outreachId: draftInput.outreachId,
          mailboxId: draftInput.mailboxId,
        });

      await send();
      // Graph has no idempotency guard of its own in the provider: the
      // protection lives in send-service via the journaled claim, and a
      // real second POST /send is rejected by the server once the draft has
      // become a sent message. mock and smtp_imap absorb the repeat call
      // without a second delivery.
      if (name === "microsoft_graph") {
        await expect(send()).rejects.toThrow();
      } else {
        await expect(send()).resolves.toEqual({ status: "accepted" });
      }

      expect(
        await provider.reconcile({
          outreachId: draftInput.outreachId,
          draftId,
          mailboxId: draftInput.mailboxId,
        }),
      ).toMatchObject({ status: "sent" });
      expect(deliveryCount()).toBe(1);
    });

    it("honours an aborted signal", async () => {
      const provider = await makeProvider();
      const controller = new AbortController();
      controller.abort();
      await expect(
        provider.createDraft({ ...draftInput, signal: controller.signal }),
      ).rejects.toThrow();
    });
  },
);
