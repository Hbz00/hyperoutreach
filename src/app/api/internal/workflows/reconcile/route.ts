import { authorizeOperatorRequest } from "@/lib/operator-auth";
import { createWorkflowDispatcher } from "@/modules/workflows/dispatcher-factory";
import { dispatchMaintenanceTick } from "@/modules/workflows/maintenance-service";
import { resolveWorkflowProvider } from "@/modules/workflows/provider-config";

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
    const outcomes = await dispatchMaintenanceTick(
      createWorkflowDispatcher(),
      resolveWorkflowProvider(process.env),
      now,
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
