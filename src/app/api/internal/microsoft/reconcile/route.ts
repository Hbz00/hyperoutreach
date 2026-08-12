import { getMicrosoftServerContext } from "@/lib/microsoft/server";
import { authorizeOperatorRequest } from "@/lib/operator-auth";
import { runMicrosoftGraphMaintenance } from "@/modules/mailboxes/microsoft-graph-sync-service";
import { createReplyClassifier } from "@/modules/replies/classifier-factory";

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
  const notificationUrl = process.env.MICROSOFT_GRAPH_NOTIFICATION_URL;
  if (!notificationUrl) {
    return Response.json(
      { error: "Microsoft notification URL is not configured" },
      { status: 503 },
    );
  }
  try {
    const { db, config, graphForMailbox } = getMicrosoftServerContext();
    const outcome = await runMicrosoftGraphMaintenance(
      db,
      graphForMailbox,
      createReplyClassifier(),
      config,
      { notificationUrl },
    );
    return Response.json(outcome);
  } catch {
    return Response.json(
      { error: "Microsoft reconciliation failed" },
      { status: 503 },
    );
  }
}
