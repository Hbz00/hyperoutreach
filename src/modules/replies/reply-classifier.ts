import { z } from "zod";

export const REPLY_CATEGORIES = [
  "positive",
  "negative",
  "question",
  "referral",
  "out_of_office",
  "unsubscribe",
  "bounce",
  "automated",
  "unknown",
] as const;

export type ReplyCategory = (typeof REPLY_CATEGORIES)[number];

export const replyClassificationSchema = z.object({
  category: z.enum(REPLY_CATEGORIES),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(1_000),
});

export type ReplyClassification = z.infer<typeof replyClassificationSchema>;
export type ReplyClassifierInput = {
  subject: string;
  body: string;
  sender: string;
};

export interface ReplyClassifier {
  readonly name: string;
  classify(input: ReplyClassifierInput): Promise<ReplyClassification>;
}

export function validateReplyClassification(
  value: unknown,
): ReplyClassification {
  return replyClassificationSchema.parse(value);
}

export class DeterministicReplyClassifier implements ReplyClassifier {
  readonly name = "deterministic-local-v1";

  async classify(input: ReplyClassifierInput): Promise<ReplyClassification> {
    const text = `${input.subject}\n${input.body}`.toLocaleLowerCase("en-US");
    const rules: Array<[RegExp, ReplyCategory, number, string]> = [
      [
        /(?:unsubscribe|remove me|stop emailing|désabonn)/,
        "unsubscribe",
        0.99,
        "Explicit opt-out phrase",
      ],
      [
        /(?:out of office|automatic reply|absent du bureau)/,
        "out_of_office",
        0.98,
        "Out-of-office phrase",
      ],
      /**
       * A delivery failure, before anything else automated.
       *
       * Ordered first among the machine-generated shapes because a bounce *is*
       * an automated message, and the looser rule below used to claim it: a
       * Gmail failure notice came back `automated`, and the three other shapes
       * a real mail system produces matched nothing at all. That matters beyond
       * this classifier — the production one is asked the same question, and a
       * local stand-in that disagrees with it about what a bounce is makes every
       * test written against it prove the wrong thing.
       *
       * Reached only when the transport could not parse the report itself: a
       * structured DSN sets `bounceKind` and never consults a classifier.
       */
      [
        /(?:mailer-daemon|postmaster@|delivery status notification|undelivered mail|undeliverable|delivery (?:has )?failed|delivery delayed|could not be delivered|address not found|recipient (?:address )?rejected|user unknown|recipientnotfound|mailbox (?:is )?full|\b[45]\.\d{1,3}\.\d{1,3}\b)/,
        "bounce",
        0.9,
        "Delivery-failure phrase",
      ],
      [
        /(?:automated message|do not reply)/,
        "automated",
        0.95,
        "Automated-message phrase",
      ],
      [
        /(?:contact|speak (?:to|with)|reach out to)\s+\p{Letter}+/u,
        "referral",
        0.9,
        "Alternative contact phrase",
      ],
      [
        /(?:no thank|not interested|decline|not a fit)/,
        "negative",
        0.9,
        "Negative intent phrase",
      ],
      [
        /(?:\byes\b|\binterested\b|schedule|book a call|sounds good)/,
        "positive",
        0.88,
        "Positive intent phrase",
      ],
      [/\?/, "question", 0.85, "Question punctuation"],
    ];
    for (const [pattern, category, confidence, reason] of rules) {
      if (pattern.test(text)) return { category, confidence, reason };
    }
    return {
      category: "unknown",
      confidence: 0.35,
      reason: "No deterministic rule matched",
    };
  }
}
