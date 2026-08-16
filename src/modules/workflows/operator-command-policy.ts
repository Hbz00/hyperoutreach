import type { WorkflowTaskName } from "@/modules/workflows/task-contracts";

/**
 * Operator commands that must not run inside the HTTP request, mapped to the
 * workflow task that does the work.
 *
 * Every one of them takes a turn on the operator's ChatGPT desktop app. That
 * app is a single window and every turn is serialized process-wide, so a
 * command running in a request could sit behind a ten-minute research turn
 * with nothing on screen — the application ships no client JavaScript and
 * cannot render progress. Worse, a request issuing a turn while the
 * maintenance cycle holds the window is the one concurrency the transport
 * cannot absorb: a turn's deadline counts from when it was asked for, queue
 * wait included, so the shorter of the two dies without ever being sent.
 */
export const QUEUED_OPERATOR_COMMANDS = {
  "discover-accounts": "account-discovery",
  "research-account": "account-research",
  "discover-contacts": "contact-discovery",
  "resolve-email": "email-resolution",
  "sync-mailbox": "reconcile-inbound-mailbox",
  // Deterministic today, and still queued: enrollment asks for the first
  // message before the prospect's address is necessarily resolved, so the work
  // has to be able to wait. Once a step can ask an agent for a sentence, the
  // same row is also the thing that must not run inside a request.
  "generate-message": "generate-message",
} as const satisfies Record<string, WorkflowTaskName>;

export type QueuedOperatorCommand = keyof typeof QUEUED_OPERATOR_COMMANDS;

export function isQueuedOperatorCommand(
  command: string,
): command is QueuedOperatorCommand {
  return command in QUEUED_OPERATOR_COMMANDS;
}

/**
 * Every workflow task that can reach the AI surface. Declared here so the
 * partition above can be checked rather than trusted.
 */
export const AI_WORKFLOW_TASKS = [
  "account-discovery",
  "account-research",
  "contact-discovery",
  "email-resolution",
  "personalize-message",
  "reconcile-inbound-mailbox",
  "reconcile-inbound-mailboxes",
] as const satisfies readonly WorkflowTaskName[];

export type WaitingReason =
  | "awaiting_reply_classification"
  | "awaiting_accepted_email"
  | "awaiting_account_research";

export type CommandDisposition =
  | { kind: "succeeded" }
  | { kind: "retry"; reason: string }
  | { kind: "waiting"; reason: WaitingReason }
  | { kind: "abandoned"; reason: string };

/** Transient by nature: the same call, later, can succeed unchanged. */
const RETRYABLE_CODES = new Set([
  "AGENT_ERROR",
  "DATABASE_ERROR",
  "PROVIDER_ERROR",
  "IN_PROGRESS",
]);

/** Not failures: work that cannot start yet, and must not spend an attempt. */
const WAITING_CODES: Record<string, WaitingReason> = {
  REPLY_PENDING: "awaiting_reply_classification",
  // No number of attempts produces evidence nobody has gathered. It clears
  // when account research completes, which the operator can also ask for.
  AWAITING_RESEARCH: "awaiting_account_research",
};

/**
 * What the queue should do with what a command actually returned.
 *
 * The workflow services resolve their failures rather than throwing — only
 * three codes are converted into exceptions upstream — so a queue that keyed
 * off exceptions alone would record `{ok: false, code: "TEMPLATE_ERROR"}` as a
 * success. That is the same silence the send notice was fixed for. Every
 * outcome lands in exactly one of four buckets, and an unrecognised code is
 * abandoned rather than retried: a visible stop beats an invisible loop on the
 * operator's own subscription.
 */
export function classifyCommandOutcome(
  outcome:
    | { status: "threw"; message: string }
    | { status: "returned"; value: unknown },
): CommandDisposition {
  if (outcome.status === "threw") {
    return { kind: "retry", reason: outcome.message };
  }
  const value = outcome.value;
  if (!value || typeof value !== "object") return { kind: "succeeded" };
  const record = value as { ok?: unknown; code?: unknown };
  if (record.ok !== false) return { kind: "succeeded" };
  const code = typeof record.code === "string" ? record.code : "UNKNOWN";
  if (RETRYABLE_CODES.has(code)) return { kind: "retry", reason: code };
  const waiting = WAITING_CODES[code];
  if (waiting) return { kind: "waiting", reason: waiting };
  return { kind: "abandoned", reason: code };
}
