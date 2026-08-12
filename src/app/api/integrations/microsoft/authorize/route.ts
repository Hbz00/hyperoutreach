import { randomBytes } from "node:crypto";

import { getMicrosoftServerContext } from "@/lib/microsoft/server";
import { mutableRedirect } from "@/lib/http-response";
import {
  authorizeOperatorRequest,
  cookieValue,
  OPERATOR_SESSION_COOKIE,
  operatorCookieSecure,
  verifyOperatorSession,
} from "@/lib/operator-auth";
import { beginMicrosoftAuthorization } from "@/modules/mailboxes/microsoft-oauth-service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = authorizeOperatorRequest(request);
  const session = verifyOperatorSession(
    cookieValue(request, OPERATOR_SESSION_COOKIE),
  );
  if (authorization !== "authorized" && !session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { db, config } = getMicrosoftServerContext();
    const operatorBinding = randomBytes(32).toString("base64url");
    const flow = await beginMicrosoftAuthorization(db, config, {
      operatorBinding,
    });
    const response = mutableRedirect(flow.authorizationUrl, 302);
    const secure = operatorCookieSecure(request) ? "; Secure" : "";
    response.headers.append(
      "Set-Cookie",
      `hyperoutreach_oauth_binding=${encodeURIComponent(operatorBinding)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`,
    );
    return response;
  } catch {
    if (session) {
      return mutableRedirect(
        new URL("/settings?microsoft=unavailable", request.url),
        303,
      );
    }
    return Response.json(
      { error: "Microsoft authorization is unavailable" },
      { status: 503 },
    );
  }
}
