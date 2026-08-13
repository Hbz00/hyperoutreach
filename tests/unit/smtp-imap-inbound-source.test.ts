import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SmtpImapInboundSource } =
  await import("@/modules/mailboxes/smtp-imap-inbound-source");
// The real downstream validator (`inbound-service.ts`) — used directly below
// to prove the sender fallback survives the exact check that would
// otherwise freeze the mailbox, not just that it "looks like an email".
const { normalizeEmail } = await import("@/modules/prospects/normalization");

describe("imap inbound source", () => {
  // L'orchestrateur fournit ingestPage ; la source pousse chaque page au fil de l'eau.
  const collect = () => {
    const seen: unknown[] = [];
    const ingestPage = async (messages: unknown[]) => {
      seen.push(...messages);
      return messages.length;
    };
    return { seen, ingestPage };
  };

  it("starts from the first uid when there is no cursor", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      // fetchRange est un generateur asynchrone pagine, pas une promesse de tableau.
      fetchRange: vi.fn().mockImplementation(async function* () {}),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const result = await source.fetchSince(null, collect().ingestPage);
    expect(imap.fetchRange).toHaveBeenCalledWith("1:*");
    expect(result.rebaselined).toBe(false);
  });

  it("resumes after the last processed uid", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      // fetchRange est un generateur asynchrone pagine, pas une promesse de tableau.
      fetchRange: vi.fn().mockImplementation(async function* () {}),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    await source.fetchSince("7:41", collect().ingestPage);
    expect(imap.fetchRange).toHaveBeenCalledWith("42:*");
  });

  it("rebaselines when uidvalidity changed", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 9 }),
      // fetchRange est un generateur asynchrone pagine, pas une promesse de tableau.
      fetchRange: vi.fn().mockImplementation(async function* () {}),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const result = await source.fetchSince("7:41", collect().ingestPage);
    expect(result.rebaselined).toBe(true);
    expect(imap.fetchRange).toHaveBeenCalledWith("1:*");
  });

  it("advances the cursor to the highest fetched uid", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
        yield [
          {
            uid: 45,
            envelope: {
              messageId: "<b@x>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    const result = await source.fetchSince("7:41", ingestPage);
    expect(result.nextCursor).toBe("7:45");
    expect(seen).toHaveLength(2);
  });

  it("keeps an earlier page ingested when a later page throws", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
        throw new Error("IMAP a coupe en pleine pagination");
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await expect(source.fetchSince("7:41", ingestPage)).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  // --- Couverture additionnelle au-dela du brief -------------------------

  it("rebaselines to uid 0 under the new epoch instead of carrying the old uid forward", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 9 }),
      fetchRange: vi.fn().mockImplementation(async function* () {}),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const result = await source.fetchSince("7:41", collect().ingestPage);
    expect(result.nextCursor).toBe("9:0");
  });

  it("dedupes the RFC 3501 6.4.8 tail redelivery instead of reingesting the last message every round", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        // "42:*" resolves "*" to the mailbox's actual highest uid (41) even
        // though 41 < 42 — the server still hands it back.
        yield [
          {
            uid: 41,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    const result = await source.fetchSince("7:41", ingestPage);
    expect(seen).toHaveLength(0);
    expect(result.nextCursor).toBe("7:41");
  });

  it("reduces a multi-address From to a single sender address via mailparser (normalizeEmail throws on a comma-joined string)", async () => {
    const raw = [
      'From: "Prospect One" <prospect1@example.com>, "Prospect Two" <prospect2@example.com>',
      "To: mailbox@example.com",
      "Subject: Re: outreach",
      "Message-ID: <reply-1@example.com>",
      "",
      "hello",
      "",
    ].join("\r\n");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "prospect1@example.com, prospect2@example.com",
              to: "m@y",
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);
    const message = seen[0] as { sender: string };
    expect(message.sender).toBe("prospect1@example.com");
    expect(message.sender).not.toContain(",");
  });

  it("reduces a multi-address envelope From to a single sender when the body cannot be parsed at all", async () => {
    // No headers mailparser can read here, so the projection must fall back
    // to `envelope.from` — this is the path that actually needs to strip a
    // comma-joined `formatAddressList` string down to one address.
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "prospect1@example.com, prospect2@example.com",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);
    const message = seen[0] as { sender: string };
    expect(message.sender).toBe("prospect1@example.com");
    expect(message.sender).not.toContain(",");
  });

  it("picks the mailbox's own address out of a Cc when the To has other recipients", async () => {
    const raw = [
      "From: prospect@example.com",
      "To: someone-else@example.com, another@example.com",
      "Cc: Mailbox One <Mailbox@Example.com>",
      "Subject: Re: outreach",
      "Message-ID: <reply-2@example.com>",
      "",
      "hello",
      "",
    ].join("\r\n");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "prospect@example.com",
              to: "someone-else@example.com, another@example.com",
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      "mailbox@example.com",
    );
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);
    const message = seen[0] as { recipient: string };
    expect(message.recipient.toLowerCase()).toBe("mailbox@example.com");
  });

  // --- Test obligatoire du brief : analyse MIME de courrier entrant ------

  it("extracts a clean text body from a multipart/alternative quoted-printable reply with accents", async () => {
    const quotedPrintableAccents =
      "Bonjour,\r\n\r\nMerci pour votre message, =E0 tr=E8s bient=F4t. =C9quipe.";
    const raw = [
      'From: "Prospect Accentue" <prospect@example.com>',
      "To: mailbox@example.com",
      "Subject: Re: Suivi",
      "Message-ID: <reply-3@example.com>",
      "In-Reply-To: <outbound-1@example.com>",
      "References: <outbound-0@example.com> <outbound-1@example.com>",
      "Date: Tue, 12 Aug 2026 10:00:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="----=_NextPart_001"',
      "",
      "------=_NextPart_001",
      'Content-Type: text/plain; charset="iso-8859-1"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      quotedPrintableAccents,
      "",
      "------=_NextPart_001",
      'Content-Type: text/html; charset="iso-8859-1"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      // Deliberately distinct from the text/plain part (not just an HTML
      // rendering of the same words): proves `text` genuinely wins over
      // `html` rather than the two happening to look alike in the fixture.
      "<html><body><p>" +
        quotedPrintableAccents.replace(/\r\n/g, "<br>") +
        " (version HTML, ne doit pas =EAtre utilis=E9e)</p></body></html>",
      "",
      "------=_NextPart_001--",
      "",
    ].join("\r\n");

    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<reply-3@example.com>",
              subject: "Re: Suivi",
              from: "prospect@example.com",
              to: "mailbox@example.com",
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as {
      body: string;
      sender: string;
      internetMessageId: string;
      inReplyTo: string;
      references: string[];
    };

    expect(message.body).toContain("à");
    expect(message.body).toContain("è");
    expect(message.body).toContain("ô");
    expect(message.body).toContain("É");
    expect(message.body).not.toMatch(/=[0-9A-F]{2}/);
    expect(message.body).not.toContain("boundary");
    expect(message.body).not.toContain("Content-Type");
    expect(message.body).not.toContain("------=_NextPart_001");
    expect(message.body).not.toContain("version HTML");
    expect(message.sender).toBe("prospect@example.com");
    expect(message.internetMessageId).toBe("<reply-3@example.com>");
    expect(message.inReplyTo).toBe("<outbound-1@example.com>");
    expect(message.references).toEqual([
      "<outbound-0@example.com>",
      "<outbound-1@example.com>",
    ]);
  });

  it("falls back to a stripped HTML body when no text/plain alternative is present", async () => {
    const raw = [
      'From: "Prospect" <prospect@example.com>',
      "To: mailbox@example.com",
      "Subject: Re: Suivi",
      "Message-ID: <reply-4@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="iso-8859-1"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "<html><body><p>Caf=E9 d=E9j=E0 vu</p><p>Deuxi=E8me paragraphe</p></body></html>",
      "",
    ].join("\r\n");

    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "prospect@example.com",
              to: "mailbox@example.com",
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as { body: string };
    expect(message.body).toContain("Café déjà vu");
    expect(message.body).toContain("Deuxième paragraphe");
    expect(message.body).not.toContain("<p>");
    expect(message.body).not.toMatch(/=[0-9A-F]{2}/);
  });

  it("caps references at the inboundSchema limit (a long thread must not poison the round)", async () => {
    const references = Array.from(
      { length: 120 },
      (_, i) => `<ref-${i}@example.com>`,
    );
    const raw = [
      "From: prospect@example.com",
      "To: mailbox@example.com",
      "Subject: Re: Suivi",
      "Message-ID: <reply-5@example.com>",
      `References: ${references.join(" ")}`,
      "",
      "hello",
      "",
    ].join("\r\n");

    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "prospect@example.com",
              to: "mailbox@example.com",
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as { references: string[] };
    expect(message.references.length).toBeLessThanOrEqual(100);
  });

  it("drops an empty envelope Message-ID instead of failing inboundSchema's min(1)", async () => {
    // body carries no headers mailparser can read (no Message-ID there
    // either), forcing the projection onto the envelope fallback — where an
    // empty string (as opposed to null) is the case `?? undefined` alone
    // does not catch.
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as { internetMessageId: string | undefined };
    expect(message.internetMessageId).toBeUndefined();
  });

  // --- Fix round 1 : multipart/related (Outlook signature image), entities,
  //     identité à deux clés, since-bounding, curseur corrompu -------------

  it("converts a multipart/related HTML-only reply (Outlook signature image) and decodes entities, unlike a hand-rolled strip", async () => {
    // Root content-type is multipart/related, not multipart/alternative:
    // mailparser leaves `parsed.text` unset here (the html part is not the
    // message's root node), so this is the actual live path for
    // `bodySource: "html"` — a fixture built as multipart/alternative would
    // not exercise it, since mailparser converts an *alternative* html part
    // to `text` itself when there's no plain-text sibling.
    const raw = [
      'From: "Prospect" <prospect@example.com>',
      "To: mailbox@example.com",
      "Subject: Re: Suivi",
      "Message-ID: <reply-related@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; type="text/html"; boundary="----=_NextPart_rel"',
      "",
      "------=_NextPart_rel",
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      "<html><body><p>Merci d&rsquo;avoir r&eacute;pondu, &agrave; bient&ocirc;t</p></body></html>",
      "",
      "------=_NextPart_rel",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <sig.png>",
      "",
      "aGVsbG8gd29ybGQ=",
      "",
      "------=_NextPart_rel--",
      "",
    ].join("\r\n");

    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "prospect@example.com",
              to: "mailbox@example.com",
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as {
      body: string;
      metadata: { bodySource: string };
    };
    expect(message.body).toBe("Merci d’avoir répondu, à bientôt");
    expect(message.body).not.toContain("&rsquo;");
    expect(message.body).not.toContain("&eacute;");
    expect(message.body).not.toMatch(/<[a-z]/i);
    expect(message.metadata.bodySource).toBe("html");
  });

  it("returns an empty body instead of dumping the raw MIME source when there is no readable text or HTML", async () => {
    // Attachment-only reply: no text/plain, no text/html anywhere.
    const raw = [
      "From: prospect@example.com",
      "To: mailbox@example.com",
      "Subject: Re: Suivi",
      "Message-ID: <reply-attachment@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="----=_NextPart_mix"',
      "",
      "------=_NextPart_mix",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="scan.pdf"',
      "",
      "aGVsbG8gd29ybGQ=",
      "",
      "------=_NextPart_mix--",
      "",
    ].join("\r\n");

    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "prospect@example.com",
              to: "mailbox@example.com",
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as {
      body: string;
      metadata: { bodySource: string };
    };
    expect(message.body).toBe("");
    expect(message.metadata.bodySource).toBe("none");
  });

  it("uses a content fingerprint for stable identity while keeping uid identity per fetch", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<stable@example.com>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as {
      providerMessageId: string;
      providerNotificationId: string;
    };
    expect(message.providerMessageId).toMatch(/^imap:sha256:[a-f0-9]{64}$/);
    expect(message.providerNotificationId).toBe("imap:7:42");
  });

  it("uses the content fingerprint even when the message carries no Message-ID", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: null,
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as {
      providerMessageId: string;
      providerNotificationId: string;
    };
    expect(message.providerMessageId).toMatch(/^imap:sha256:[a-f0-9]{64}$/);
    expect(message.providerNotificationId).toBe("imap:7:42");
  });

  it("does not collapse two distinct messages that reuse the same Message-ID", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<reused@example.com>",
              subject: "one",
              from: "p@x",
              to: "m@y",
              date: new Date(0),
            },
            body: "first",
          },
          {
            uid: 43,
            envelope: {
              messageId: "<reused@example.com>",
              subject: "two",
              from: "p@x",
              to: "m@y",
              date: new Date(1),
            },
            body: "second",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);
    const ids = seen.map(
      (message) => (message as { providerMessageId: string }).providerMessageId,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("prefers IMAP INTERNALDATE (server-trusted) over the sender-controlled Date: header for receivedAt", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              date: new Date("2020-01-01T00:00:00.000Z"),
            },
            internalDate: new Date("2026-08-01T00:00:00.000Z"),
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as { receivedAt: Date };
    expect(message.receivedAt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
  });

  it("treats an unparseable stored cursor as a rebaseline, not a silent full walk reported as a normal sync", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {}),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const result = await source.fetchSince(
      "not-a-cursor",
      collect().ingestPage,
    );
    expect(result.rebaselined).toBe(true);
    expect(imap.fetchRange).toHaveBeenCalledWith("1:*");
  });

  it("does not read a truncated cursor's empty uid half as lastUid 0 (Number('') pitfall)", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {}),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const result = await source.fetchSince("7:", collect().ingestPage);
    // A genuine `lastUid: 0` under the same uidValidity would resume at
    // "1:*" too, so the discriminating assertion is `rebaselined`, not the
    // range: an unparseable cursor must be honestly reported as a
    // rebaseline, not silently folded into "resumed normally from 0".
    expect(result.rebaselined).toBe(true);
    expect(imap.fetchRange).toHaveBeenCalledWith("1:*");
  });

  it("bounds a fresh walk to the first uid on or after `since`, instead of walking the whole mailbox", async () => {
    const findFirstUidSince = vi.fn().mockResolvedValue(500);
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7, uidNext: 900 }),
      fetchRange: vi.fn().mockImplementation(async function* () {}),
      findFirstUidSince,
    };
    const since = new Date("2026-08-01T00:00:00.000Z");
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      undefined,
      since,
    );
    const result = await source.fetchSince(null, collect().ingestPage);

    expect(findFirstUidSince).toHaveBeenCalledWith(since);
    expect(imap.fetchRange).toHaveBeenCalledWith("500:*");
    expect(result.nextCursor).toBe("7:499");
  });

  it("falls back to uidNext (not uid 1) when nothing matches `since` — a freshly connected mailbox must not backfill any history", async () => {
    const findFirstUidSince = vi.fn().mockResolvedValue(null);
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7, uidNext: 900 }),
      fetchRange: vi.fn().mockImplementation(async function* () {}),
      findFirstUidSince,
    };
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      undefined,
      new Date("2026-08-01T00:00:00.000Z"),
    );
    const result = await source.fetchSince(null, collect().ingestPage);

    expect(imap.fetchRange).toHaveBeenCalledWith("900:*");
    expect(result.nextCursor).toBe("7:899");
  });

  it("never calls findFirstUidSince when since is omitted (old callers/tests keep the unbounded 1:* behavior exactly)", async () => {
    const findFirstUidSince = vi.fn();
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7, uidNext: 900 }),
      fetchRange: vi.fn().mockImplementation(async function* () {}),
      findFirstUidSince,
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    await source.fetchSince(null, collect().ingestPage);

    expect(findFirstUidSince).not.toHaveBeenCalled();
    expect(imap.fetchRange).toHaveBeenCalledWith("1:*");
  });

  // --- Fix round 2/5 -------------------------------------------------------

  it("falls back to a placeholder sender instead of an empty one that would freeze the mailbox forever", async () => {
    // Neither a parseable `From:` (body is unparseable) nor an
    // `envelope.from` (null): sender has no real value to fall back to,
    // unlike recipient's `mailboxEmail`.
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: null,
              to: "m@y",
              date: new Date(0),
            },
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as { sender: string };
    expect(message.sender.length).toBeGreaterThan(0);
    // The exact check that throws `INVALID_INPUT` (and freezes the cursor)
    // in `inbound-service.ts` if this fallback were ever empty or malformed.
    expect(() => normalizeEmail(message.sender)).not.toThrow();
  });

  // --- Fix round 3/5 ---------------------------------------------------

  it('falls back to a placeholder sender when From: has a display name but no address (mailparser: address === "", not null/undefined)', async () => {
    // Real-world case, reproduced against mailparser directly before writing
    // this fixture: `From: Some Name` (no `<addr>`) parses to
    // `parsed.from.value[0].address === ""` — not falsy to `??`, which only
    // treats `null`/`undefined` as "nothing" and would let `""` straight
    // through to `inboundSchema`'s `.min(1)`.
    const raw = [
      "From: Some Name",
      "To: mailbox@example.com",
      "Subject: Re: Suivi",
      "Message-ID: <a@x>",
      "",
      "hello",
      "",
    ].join("\r\n");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: null,
              to: "mailbox@example.com",
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as { sender: string };
    expect(message.sender.length).toBeGreaterThan(0);
    expect(() => normalizeEmail(message.sender)).not.toThrow();
  });

  it('falls back past a To: with a display name but no address (mailparser: address === "") instead of freezing on recipient', async () => {
    const raw = [
      "From: prospect@example.com",
      "To: Some List",
      "Subject: Re: Suivi",
      "Message-ID: <a@x>",
      "",
      "hello",
      "",
    ].join("\r\n");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "prospect@example.com",
              to: null,
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    // No mailboxEmail passed either, so the chain must reach the terminal
    // placeholder, not stop early on the empty-address To: entry.
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as { recipient: string };
    expect(message.recipient.length).toBeGreaterThan(0);
  });

  it("still resolves a real mailboxEmail recipient past a To: entry with a display name but no address", async () => {
    const raw = [
      "From: prospect@example.com",
      "To: Some List",
      "Cc: Mailbox One <mailbox@example.com>",
      "Subject: Re: Suivi",
      "Message-ID: <a@x>",
      "",
      "hello",
      "",
    ].join("\r\n");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "prospect@example.com",
              to: null,
              date: new Date(0),
            },
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      "mailbox@example.com",
    );
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as { recipient: string };
    expect(message.recipient.toLowerCase()).toBe("mailbox@example.com");
  });

  it("falls back to a valid receivedAt when internalDate is null and envelope.date is not an actual Date (imapflow contradicting its own typing)", async () => {
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: "p@x",
              to: "m@y",
              // A raw unparsed string, not a `Date` — reproduces imapflow
              // handing back something that contradicts its own `.d.ts`
              // (`date?: Date`) when the `Date:` header is unparseable.
              date: "not-a-real-date" as unknown as Date,
            },
            internalDate: null,
            body: "b",
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    const message = seen[0] as { receivedAt: Date };
    expect(message.receivedAt).toBeInstanceOf(Date);
    // The exact check `inboundSchema`'s `z.coerce.date()` performs — an
    // Invalid Date's `getTime()` is `NaN`, which fails coercion downstream.
    expect(Number.isNaN(message.receivedAt.getTime())).toBe(false);
  });

  // --- C1 : le contrôle qui vit EN AVAL du schéma zod --------------------
  //
  // `ingestInboundMessage` applique `normalizeEmail` au `sender` APRÈS que
  // `inboundSchema` a accepté la charge. Cette fonction est bien plus stricte
  // que `.trim().min(1).max(500)` et elle LÈVE. Sans le correctif, chacun des
  // cas ci-dessous rend `INVALID_INPUT` sans rien écrire en base, ce que
  // `inbound-reconciliation.ts` transforme en `throw` — le curseur n'avance
  // jamais et la boîte est gelée pour toujours sur ce message.

  const projectFrom = async (headers: string[], mailboxEmail?: string) => {
    const raw = [...headers, "Subject: Re: outreach", "", "hello", ""].join(
      "\r\n",
    );
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a@x>",
              subject: "s",
              from: null,
              to: null,
              date: new Date(0),
            },
            internalDate: new Date(0),
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      mailboxEmail,
    );
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);
    return seen[0] as {
      sender: string;
      recipient: string;
      metadata: Record<string, unknown>;
    };
  };

  it("projects a normalizeEmail-safe sender for From: <root@localhost> instead of freezing the mailbox forever", async () => {
    // Contre-preuve du défaut lui-même : c'est bien `normalizeEmail` — pas
    // `inboundSchema` — qui refuse cette adresse. Un avis de quota Zimbra, un
    // retour de cron ou un `MAILER-DAEMON` la porte tous.
    expect(() => normalizeEmail("root@localhost")).toThrow();

    const message = await projectFrom([
      "From: <root@localhost>",
      "To: mailbox@example.com",
      "Message-ID: <quota-warning@localhost>",
    ]);

    expect(message.sender).toBe("unknown-sender@unparseable.invalid");
    // L'assertion qui compte : la valeur retenue passe le contrôle aval.
    expect(() => normalizeEmail(message.sender)).not.toThrow();
    // Rien n'est perdu : l'opérateur voit toujours d'où venait le message.
    expect(message.metadata.unparseableSender).toBe("root@localhost");
  });

  it("keeps every hostile From: survivable by the post-schema normalizeEmail", async () => {
    const hostile = [
      // Domaine à un seul label — la classe de C1.
      "From: <root@localhost>",
      // Lettre accentuée dans la partie locale : refusée par le regex ASCII.
      "From: <prénom@example.com>",
      // Partie locale de plus de 64 caractères.
      `From: <${"a".repeat(70)}@example.com>`,
      // Adresse sans arobase du tout.
      "From: MAILER-DAEMON",
      // Point final dans la partie locale.
      "From: <bad.@example.com>",
      // Domaine IPv4 littéral entre crochets (jamais un domaine valide ici).
      "From: <postmaster@[127.0.0.1]>",
    ];
    for (const header of hostile) {
      const message = await projectFrom([header, "To: mailbox@example.com"]);
      expect(() => normalizeEmail(message.sender)).not.toThrow();
      expect(() => normalizeEmail(message.recipient)).not.toThrow();
    }
  });

  it("projects a normalizeEmail-safe recipient when the To: address is itself unnormalizable", async () => {
    const message = await projectFrom([
      "From: prospect@example.com",
      "To: <root@localhost>",
    ]);

    expect(message.sender).toBe("prospect@example.com");
    expect(message.recipient).toBe("unknown-recipient@unparseable.invalid");
    expect(() => normalizeEmail(message.recipient)).not.toThrow();
    expect(message.metadata.unparseableRecipient).toBe("root@localhost");
  });

  // --- I4 : SEARCH SINCE est de granularité JOUR ------------------------
  //
  // RFC 3501 §6.4.4 : `SEARCH SINCE` ignore l'heure et le fuseau. L'ancre
  // vaut « maintenant moins 5 minutes », mais côté serveur elle se résout en
  // « depuis ce matin minuit » — le premier parcours part donc du premier UID
  // de la journée et ramasse tout le courrier personnel reçu depuis. Chacun
  // de ces messages part chez le classifieur OpenAI et se retrouve en clair
  // dans `inbound_records.metadata`. Le SEARCH reste le filtre grossier côté
  // serveur ; le filtre fin est ici.

  const datedMessage = (uid: number, internalDate: Date | null) => ({
    uid,
    envelope: {
      messageId: `<msg-${uid}@example.com>`,
      subject: "s",
      from: "prospect@example.com",
      to: "mailbox@example.com",
      date: internalDate ?? new Date(0),
    },
    internalDate,
    body: "b",
  });

  it("drops messages that arrived before the anchor on a first walk, and still advances the cursor past them", async () => {
    const anchor = new Date("2026-08-12T14:00:00.000Z");
    // What a real `SEARCH SINCE 12-Aug-2026` hands back: everything since
    // midnight, not since 14:00.
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7, uidNext: 300 }),
      findFirstUidSince: vi.fn().mockResolvedValue(100),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          datedMessage(100, new Date("2026-08-12T07:12:00.000Z")), // courrier perso du matin
          datedMessage(101, new Date("2026-08-12T09:40:00.000Z")), // idem
          datedMessage(102, new Date("2026-08-12T14:03:00.000Z")), // après l'ancre
        ];
      }),
    };
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      undefined,
      anchor,
    );
    const { seen, ingestPage } = collect();
    const result = await source.fetchSince(null, ingestPage);

    expect(imap.fetchRange).toHaveBeenCalledWith("100:*");
    expect(seen).toHaveLength(1);
    expect((seen[0] as { internetMessageId: string }).internetMessageId).toBe(
      "<msg-102@example.com>",
    );
    // Le curseur passe quand même au-delà des messages écartés : sinon chaque
    // tour refetcherait la même journée indéfiniment.
    expect(result.nextCursor).toBe("7:102");
  });

  it("keeps a message whose INTERNALDATE is unknown rather than guessing it is old", async () => {
    const anchor = new Date("2026-08-12T14:00:00.000Z");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7, uidNext: 300 }),
      findFirstUidSince: vi.fn().mockResolvedValue(100),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [datedMessage(100, null)];
      }),
    };
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      undefined,
      anchor,
    );
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);

    expect(seen).toHaveLength(1);
  });

  it("never date-filters a resumed walk: a filed or COPYed message keeps an old INTERNALDATE and is still new", async () => {
    const anchor = new Date("2026-08-12T14:00:00.000Z");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7, uidNext: 300 }),
      findFirstUidSince: vi.fn().mockResolvedValue(100),
      fetchRange: vi.fn().mockImplementation(async function* () {
        // uid 200 n'a jamais été vu (curseur à 199) mais porte une date
        // d'arrivée antérieure à l'ancre : un filtre serveur (Zimbra, Sieve)
        // ou un COPY/APPEND préserve l'INTERNALDATE d'origine. C'est une
        // vraie réponse, peut-être une désinscription.
        yield [datedMessage(200, new Date("2026-08-11T08:00:00.000Z"))];
      }),
    };
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      undefined,
      anchor,
    );
    const { seen, ingestPage } = collect();
    const result = await source.fetchSince("7:199", ingestPage);

    expect(imap.fetchRange).toHaveBeenCalledWith("200:*");
    expect(seen).toHaveLength(1);
    expect(result.nextCursor).toBe("7:200");
  });

  it("applies the anchor again after a UIDVALIDITY rebaseline, which restarts a fresh walk", async () => {
    const anchor = new Date("2026-08-12T14:00:00.000Z");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 9, uidNext: 300 }),
      findFirstUidSince: vi.fn().mockResolvedValue(1),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          datedMessage(1, new Date("2026-08-12T06:00:00.000Z")),
          datedMessage(2, new Date("2026-08-12T15:00:00.000Z")),
        ];
      }),
    };
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      undefined,
      anchor,
    );
    const { seen, ingestPage } = collect();
    const result = await source.fetchSince("7:41", ingestPage);

    expect(result.rebaselined).toBe(true);
    expect(seen).toHaveLength(1);
    expect(result.nextCursor).toBe("9:2");
  });

  // --- C1, porte « encodage » : l'octet NUL -----------------------------
  //
  // Un `` (U+0000) n'est ni une question de largeur ni de vacuité : il
  // survit à `trim()` (ce n'est pas un blanc) comme à `slice()`, et
  // `inboundSchema` ne s'en soucie pas. Postgres, lui, le refuse deux fois :
  // `22P05` sur l'insert `jsonb` de `inbound_records.metadata` et `22021`
  // sur les colonnes `text` (`replies.body`/`.subject`/`.sender`). Les deux
  // remontent en `DATABASE_ERROR`, donc en `throw`, donc en curseur gelé —
  // C1 exactement, par une porte qu'un contrôle de longueur ne trouve pas.

  it("strips NUL bytes from every text value it projects, not only body and subject", async () => {
    const raw = [
      'From: "Prospect\u0000 Cassé" <prospect@example.com>',
      "To: mailbox@example.com",
      "Subject: Re: su\u0000jet",
      "Message-ID: <re\u0000ply@example.com>",
      "In-Reply-To: <out\u0000bound@example.com>",
      "References: <ref\u0000-a@example.com> <ref-b@example.com>",
      "",
      "Bonjour,\u0000 le corps porte un octet nul.",
      "",
    ].join("\r\n");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<a\u0000@x>",
              subject: "su\u0000jet",
              from: "pro\u0000spect@example.com",
              to: "mail\u0000box@example.com",
              date: new Date(0),
            },
            internalDate: new Date(0),
            body: raw,
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(imap as never, "mbx-1");
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);
    const message = seen[0] as Record<string, unknown>;

    // Le corps porte bien le NUL en amont : sans quoi ce test ne prouverait
    // rien (c'est la prémisse, pas la conclusion).
    expect(raw).toContain("\u0000");

    // Balayage exhaustif de la projection, plutôt qu'une liste de champs
    // écrite à la main : un champ ajouté plus tard est couvert d'office.
    const offenders: string[] = [];
    const scan = (value: unknown, path: string) => {
      if (typeof value === "string") {
        if (value.includes("\u0000")) offenders.push(path);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => scan(entry, `${path}[${index}]`));
        return;
      }
      if (value && typeof value === "object" && !(value instanceof Date)) {
        for (const [key, entry] of Object.entries(value)) {
          scan(entry, `${path}.${key}`);
        }
      }
    };
    scan(message, "message");
    expect(offenders).toEqual([]);

    // Et le contenu utile survit au nettoyage : on retire l'octet, pas le
    // message.
    expect(message.body).toContain("le corps porte un octet nul");
    expect(message.subject).toBe("Re: sujet");
  });

  it("projects a standard delivery-status report as a hard bounce tied to the original message", async () => {
    const raw = [
      "From: Mail Delivery System <mailer-daemon@example.net>",
      "To: mailbox@example.com",
      "Subject: Delivery Status Notification (Failure)",
      "Message-ID: <dsn-1@example.net>",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="dsn-boundary"',
      "",
      "--dsn-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Delivery failed.",
      "--dsn-boundary",
      "Content-Type: message/delivery-status",
      "",
      "Final-Recipient: rfc822; prospect@example.com",
      "Action: failed",
      "Status: 5.1.1",
      "Diagnostic-Code: smtp; 550 5.1.1 No such user",
      "--dsn-boundary",
      "Content-Type: message/rfc822",
      "",
      "From: mailbox@example.com",
      "To: prospect@example.com",
      "Message-ID: <outreach-123@example.com>",
      "X-Outreach-ID: outreach-123",
      "Subject: Hello",
      "",
      "Original body",
      "--dsn-boundary--",
      "",
    ].join("\r\n");
    const imap = {
      status: vi.fn().mockResolvedValue({ uidValidity: 7 }),
      fetchRange: vi.fn().mockImplementation(async function* () {
        yield [
          {
            uid: 42,
            envelope: {
              messageId: "<dsn-1@example.net>",
              subject: "Delivery Status Notification (Failure)",
              from: "mailer-daemon@example.net",
              to: "mailbox@example.com",
              date: new Date(0),
            },
            internalDate: new Date(0),
            body: Buffer.from(raw),
          },
        ];
      }),
    };
    const source = new SmtpImapInboundSource(
      imap as never,
      "mbx-1",
      "mailbox@example.com",
    );
    const { seen, ingestPage } = collect();
    await source.fetchSince(null, ingestPage);
    expect(seen[0]).toMatchObject({
      bounceKind: "hard",
      bouncedRecipient: "prospect@example.com",
      inReplyTo: "<outreach-123@example.com>",
      outreachId: "outreach-123",
    });
  });

  it("falls back to the placeholder for an address made only of NUL bytes", async () => {
    // `stripNul` avant `trim` : sinon la valeur reste « non vide » pour
    // `.min(1)` et c'est la base qui la refuse, un tour trop tard.
    const message = await projectFrom([
      "From: <\u0000\u0000\u0000>",
      "To: mailbox@example.com",
    ]);
    expect(message.sender).toBe("unknown-sender@unparseable.invalid");
    expect(() => normalizeEmail(message.sender)).not.toThrow();
  });

  it("pins both terminal placeholders as normalizeEmail-safe", () => {
    // Le commentaire d'en-tête du module l'affirmait depuis la Task 11 ; rien
    // ne le prouvait, et C1 est précisément né d'une affirmation non vérifiée
    // sur la couche du dessous.
    expect(normalizeEmail("unknown-sender@unparseable.invalid")).toBe(
      "unknown-sender@unparseable.invalid",
    );
    expect(normalizeEmail("unknown-recipient@unparseable.invalid")).toBe(
      "unknown-recipient@unparseable.invalid",
    );
  });
});
