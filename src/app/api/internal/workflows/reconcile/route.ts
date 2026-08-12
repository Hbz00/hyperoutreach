import { authorizeOperatorRequest } from "@/lib/operator-auth";
import { createWorkflowDispatcher } from "@/modules/workflows/dispatcher-factory";
import { recoveryDispatchKey } from "@/modules/workflows/recovery-service";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const authorization = authorizeOperatorRequest(request);
  if (authorization === "unconfigured") {
    return Response.json(
      { error: "Operator authentication is not configured" },
      { status: 503 },
    );
  }
  if (authorization !== "authorized") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  try {
    const outcome = await createWorkflowDispatcher().dispatch({
      task: "recover-stale-work",
      payload: { observedAt: now.toISOString() },
      idempotencyKey: recoveryDispatchKey(now),
    });
    return Response.json(outcome, { status: outcome.duplicate ? 200 : 202 });
  } catch {
    return Response.json(
      { error: "Workflow recovery dispatch failed" },
      { status: 503 },
    );
  }
}
