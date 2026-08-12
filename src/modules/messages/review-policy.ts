export type ReviewableMessage = {
  status: "proposed" | "approved" | "cancelled" | "sent";
  subject: string;
  body: string;
};

export type ReviewAction =
  | { kind: "approve" }
  | { kind: "edit_and_approve"; subject: string; body: string }
  | { kind: "reject"; reason: string };

export type ReviewTransitionResult =
  | {
      ok: true;
      status: "approved" | "cancelled";
      subject: string;
      body: string;
      reason?: string;
    }
  | { ok: false; code: "INVALID_CONTENT" }
  | {
      ok: false;
      code: "INVALID_TRANSITION";
      from: ReviewableMessage["status"];
      action: ReviewAction["kind"];
    };

export function evaluateReviewTransition(
  message: ReviewableMessage,
  action: ReviewAction,
): ReviewTransitionResult {
  if (message.status !== "proposed") {
    return {
      ok: false,
      code: "INVALID_TRANSITION",
      from: message.status,
      action: action.kind,
    };
  }
  if (action.kind === "edit_and_approve") {
    if (!action.subject.trim() || !action.body.trim()) {
      return { ok: false, code: "INVALID_CONTENT" };
    }
    return {
      ok: true,
      status: "approved",
      subject: action.subject,
      body: action.body,
    };
  }
  if (action.kind === "reject") {
    if (!action.reason.trim()) {
      return { ok: false, code: "INVALID_CONTENT" };
    }
    return {
      ok: true,
      status: "cancelled",
      subject: message.subject,
      body: message.body,
      reason: action.reason,
    };
  }
  return {
    ok: true,
    status: "approved",
    subject: message.subject,
    body: message.body,
  };
}
