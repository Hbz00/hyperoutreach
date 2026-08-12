import { after } from "next/server";

import { getMicrosoftServerContext } from "@/lib/microsoft/server";
import { stageGraphWebhook } from "@/modules/mailboxes/microsoft-graph-sync-service";
import { createWorkflowDispatcher } from "@/modules/workflows/dispatcher-factory";

export const runtime = "nodejs";

function validationResponse(request: Request): Response | null {
  const validationToken = new URL(request.url).searchParams.get(
    "validationToken",
  );
  if (!validationToken) return null;
  return new Response(validationToken, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(request: Request) {
  return validationResponse(request) ?? new Response(null, { status: 405 });
}

export async function POST(request: Request) {
  const validation = validationResponse(request);
  if (validation) return validation;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid notification payload" },
      { status: 400 },
    );
  }
  try {
    const { db, config } = getMicrosoftServerContext();
    const outcome = await stageGraphWebhook(db, config, payload);
    if (
      outcome.rejected > 0 &&
      outcome.accepted === 0 &&
      outcome.duplicates === 0
    ) {
      return Response.json({ error: "Notification rejected" }, { status: 401 });
    }
    after(async () => {
      await createWorkflowDispatcher().dispatch({
        task: "drain-graph-webhooks",
        payload: { observedAt: new Date().toISOString() },
        idempotencyKey: `graph-webhook-drain:${crypto.randomUUID()}`,
      });
    });
    return new Response(null, { status: 202 });
  } catch {
    return Response.json(
      { error: "Notification processing unavailable" },
      { status: 503 },
    );
  }
}
