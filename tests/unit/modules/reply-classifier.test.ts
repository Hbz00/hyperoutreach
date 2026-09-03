import { describe, expect, it } from "vitest";

import {
  DeterministicReplyClassifier,
  validateReplyClassification,
} from "@/modules/replies/reply-classifier";
import { mapReplyOutcome } from "@/modules/replies/reply-policy";

describe("reply classification boundary", () => {
  it.each([
    ["Please unsubscribe me", "unsubscribe"],
    ["Automatic reply: out of office", "out_of_office"],
    ["Yes, let's schedule a call", "positive"],
    ["No thank you", "negative"],
    ["No thanks, not interested", "negative"],
    ["Could you share pricing?", "question"],
    ["Please contact Marie instead", "referral"],
    // Every shape below is one a real mail system produces when the transport
    // could not parse the report itself — the only case that ever reaches a
    // classifier, since a structured DSN sets `bounceKind` and skips it. All
    // four were put to the production classifier, which answered `bounce` with
    // 0.99 confidence; a local stand-in that answered otherwise would make
    // every test written against it prove the wrong thing.
    ["Delivery status notification", "bounce"],
    ["Undelivered Mail Returned to Sender: user unknown", "bounce"],
    [
      "Your message couldn't be delivered — RESOLVER.ADR.RecipientNotFound",
      "bounce",
    ],
    ["Address not found. 550 5.1.1 the account does not exist", "bounce"],
    ["452 4.2.2 Mailbox full, the server will retry", "bounce"],
    // Automated and not a failure: the category that used to swallow all of
    // the above.
    ["This is an automated message; do not reply", "automated"],
    ["Noted", "unknown"],
  ])("classifies deterministic local text", async (body, category) => {
    const result = await new DeterministicReplyClassifier().classify({
      subject: "Re: hello",
      body,
      sender: "person@example.com",
    });
    expect(result.category).toBe(category);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  /**
   * The prospects this product writes to run lorries.
   *
   * "The delivery failed", "could not be delivered", "the address was rejected"
   * are things their staff say about freight, in a real reply, all day. A rule
   * that reads only the words turns those into bounces — and a bounce
   * classification is what suppresses an address permanently. The sender is what
   * separates a mail system from a customer talking about a lorry.
   */
  it.each([
    [
      "Our delivery failed at the Lyon depot yesterday, could you resend the documents?",
      "marie.durand@transport-nord.example",
      "question",
    ],
    [
      "Two pallets could not be delivered because the address was rejected by the site.",
      "paul.martin@transport-nord.example",
      "unknown",
    ],
    [
      "Delivery delayed again on the Marseille run.",
      "MAILER-DAEMON@transport-nord.example",
      "bounce",
    ],
    // A bare status triple is a version number as often as it is an SMTP code.
    [
      "We run 5.2.1 in production; the migration is planned for October.",
      "marie.durand@transport-nord.example",
      "unknown",
    ],
    [
      "Diagnostic code 5.2.1, the mailbox is over quota.",
      "postmaster@transport-nord.example",
      "bounce",
    ],
  ])(
    "reads the sender before calling freight talk a bounce",
    async (body, sender, category) => {
      const result = await new DeterministicReplyClassifier().classify({
        subject: "Re: votre flotte",
        body,
        sender,
      });
      expect(result.category).toBe(category);
    },
  );

  /**
   * The same questions, asked in the prospects' own language.
   *
   * The rule table was written in English with two French tokens bolted on, so
   * a French refusal, a French opt-out and a French out-of-office all fell
   * through to `unknown`. Two did worse than fall through: "après avoir pris
   * contact avec mon équipe, je ne suis pas intéressé" came back `referral` at
   * 0.90 because the referral rule reads the word "contact" and "pris contact
   * avec" contains it, and a plain acceptance came back `question` because it
   * ended in a question mark. Both are terminal, so both wrote a permanently
   * wrong stop reason.
   */
  it.each([
    ["Bonjour, je ne suis pas intéressé.", "negative"],
    ["Non merci.", "negative"],
    ["Ce n'est pas une priorité pour nous cette année.", "negative"],
    ["Merci de me retirer de votre liste de diffusion.", "unsubscribe"],
    ["Arrêtez de m'envoyer des emails.", "unsubscribe"],
    ["Je suis absent jusqu'au 3 septembre.", "out_of_office"],
    ["Merci de voir avec Marie Dupont qui gère ce sujet.", "referral"],
    ["Oui, cela m'intéresse. Pouvons-nous en discuter ?", "positive"],
    // The confident wrong answer, kept as a regression: an explicit refusal
    // must outrank the mention of a colleague it was reached through.
    [
      "Après avoir pris contact avec mon équipe, je ne suis pas intéressé.",
      "negative",
    ],
  ])("classifies French reply text", async (body, category) => {
    const result = await new DeterministicReplyClassifier().classify({
      subject: "Re: votre flotte",
      body,
      sender: "person@example.com",
    });
    expect(result.category).toBe(category);
  });

  it("reads a French out-of-office subject", async () => {
    const result = await new DeterministicReplyClassifier().classify({
      subject: "Réponse automatique",
      body: "Je serai de retour le 2 septembre.",
      sender: "person@example.com",
    });
    expect(result.category).toBe("out_of_office");
  });

  /**
   * The freight guard, in French.
   *
   * "N'a pas pu être livré" is what a haulier writes about a pallet and what a
   * mail system writes about a message. The sender is what tells them apart
   * here exactly as it does in English, and the French mail wording admitted
   * below is deliberately postal rather than logistic — "remis", "adresse
   * inconnue" — so a customer describing a failed delivery is never suppressed.
   */
  it.each([
    [
      "Notre livraison a échoué au dépôt de Lyon, pouvez-vous renvoyer les documents ?",
      "marie.durand@transport-nord.example",
      "question",
    ],
    [
      "Deux palettes n'ont pas pu être livrées hier à cause de l'adresse du site.",
      "paul.martin@transport-nord.example",
      "unknown",
    ],
    [
      "Votre message n'a pas pu être remis. Adresse inconnue.",
      "MAILER-DAEMON@transport-nord.example",
      "bounce",
    ],
    [
      "Le destinataire est inconnu sur ce serveur.",
      "postmaster@transport-nord.example",
      "bounce",
    ],
  ])(
    "reads the sender before calling French freight talk a bounce",
    async (body, sender, category) => {
      const result = await new DeterministicReplyClassifier().classify({
        subject: "RE: votre flotte",
        body,
        sender,
      });
      expect(result.category).toBe(category);
    },
  );

  it("rejects an invalid provider classification", () => {
    expect(() =>
      validateReplyClassification({
        category: "maybe",
        confidence: 2,
        reason: "invalid",
      }),
    ).toThrow();
  });
});

describe("reply terminal mapping", () => {
  it.each([
    ["positive", "replied", "positive_reply", true],
    ["negative", "replied", "negative_reply", true],
    ["question", "replied", "question", true],
    ["referral", "replied", "referral", true],
    ["unsubscribe", "opted_out", "unsubscribe", true],
  ] as const)(
    "maps %s to a terminal enrollment",
    (category, state, reason, terminal) => {
      expect(mapReplyOutcome(category, null, true)).toMatchObject({
        state,
        stopReason: reason,
        terminal,
        clearSchedule: true,
      });
    },
  );

  it("distinguishes hard and soft bounce", () => {
    expect(mapReplyOutcome("bounce", "hard", true)).toMatchObject({
      state: "bounced",
      stopReason: "hard_bounce",
      suppressRecipient: true,
      terminal: true,
    });
    expect(mapReplyOutcome("bounce", "soft", true)).toMatchObject({
      state: "manual_review",
      stopReason: null,
      suppressRecipient: false,
      terminal: false,
    });
  });

  /**
   * A delay notice is not a delivery failure.
   *
   * RFC 3464 separates `Action: delayed` — "I have not managed it yet and I am
   * still retrying" — from `Action: failed` — "I retried and I am giving up".
   * The transport already reads that field and then threw the distinction away
   * one line later, so a routine delay notice stopped a sequence dead and
   * cleared its schedule. Greylisting makes that the ordinary case for a cold
   * first send, which is this product's entire profile.
   *
   * The definitive answer still arrives: a message that ultimately fails
   * produces a second report, and that one parks.
   */
  it("resumes a sequence on a delay notice instead of parking it", () => {
    expect(mapReplyOutcome("bounce", "delayed", true)).toMatchObject({
      state: null,
      stopReason: null,
      terminal: false,
      clearSchedule: false,
      restoreSchedule: true,
      suppressRecipient: false,
    });
  });

  it("parks a delivery the server gave up on, whatever the hold setting", () => {
    for (const holdNonTerminal of [true, false]) {
      expect(mapReplyOutcome("bounce", "soft", holdNonTerminal)).toMatchObject({
        state: "manual_review",
        terminal: false,
        clearSchedule: true,
        restoreSchedule: false,
        suppressRecipient: false,
      });
    }
  });

  it("holds non-terminal automated replies when configured", () => {
    expect(mapReplyOutcome("out_of_office", null, true)).toMatchObject({
      state: "manual_review",
      clearSchedule: true,
      terminal: false,
    });
    expect(mapReplyOutcome("unknown", null, false)).toMatchObject({
      state: null,
      clearSchedule: false,
      terminal: false,
    });
  });
});
