import { authorizeOperatorRequest } from "@/lib/operator-auth";
import { createWorkflowDispatcher } from "@/modules/workflows/dispatcher-factory";
import { dispatchMaintenanceTick } from "@/modules/workflows/maintenance-service";

export const runtime = "nodejs";
export const maxDuration = 1500;

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
  // `?immediate=1` runs a cycle now instead of deduplicating against the
  // minute the scheduler may already have used. The singleton lease still
  // decides whether it actually runs.
  const immediate = new URL(request.url).searchParams.get("immediate") === "1";
  try {
    const outcomes = await dispatchMaintenanceTick(
      createWorkflowDispatcher(),
      now,
      { immediate },
    );
    return Response.json(
      { outcomes },
      { status: outcomes.every((outcome) => outcome.duplicate) ? 200 : 202 },
    );
  } catch {
    return Response.json(
      { error: "Workflow maintenance failed" },
      { status: 503 },
    );
  }
}
