import { getMicrosoftServerContext } from "@/lib/microsoft/server";
import { mutableRedirect } from "@/lib/http-response";
import { cookieValue } from "@/lib/operator-auth";
import {
  completeMicrosoftConnection,
  consumeMicrosoftAuthorizationState,
} from "@/modules/mailboxes/microsoft-oauth-service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const operatorBinding = cookieValue(request, "hyperoutreach_oauth_binding");
  if (!code || !state || !operatorBinding || url.searchParams.has("error")) {
    return Response.json(
      { error: "Microsoft authorization was rejected" },
      { status: 400 },
    );
  }
  try {
    const { db, config } = getMicrosoftServerContext();
    const verified = await consumeMicrosoftAuthorizationState(db, config, {
      state,
      operatorBinding,
    });
    if (!verified.ok) {
      return Response.json(
        { error: "Microsoft authorization state is invalid" },
        { status: 400 },
      );
    }
    const result = await completeMicrosoftConnection(db, config, {
      code,
      codeVerifier: verified.codeVerifier,
    });
    if (!result.ok) {
      return Response.json(
        { error: "Microsoft connection failed" },
        { status: 502 },
      );
    }
    const response = mutableRedirect("/settings?microsoft=connected", 303);
    response.headers.append(
      "Set-Cookie",
      "hyperoutreach_oauth_binding=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    return response;
  } catch {
    return Response.json(
      { error: "Microsoft connection failed" },
      { status: 503 },
    );
  }
}
