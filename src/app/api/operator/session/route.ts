import { z } from "zod";

import {
  cookieValue,
  createOperatorSession,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_TTL_SECONDS,
  operatorCookieSecure,
  safeOperatorRedirect,
  verifyCsrfToken,
  verifyOperatorCredentials,
  verifyOperatorSession,
} from "@/lib/operator-auth";
import { mutableRedirect } from "@/lib/http-response";
import { OperatorLoginThrottle } from "@/lib/operator-login-throttle";

export const runtime = "nodejs";

const loginSchema = z.object({
  email: z.string().trim().max(320),
  password: z.string().max(1_000),
  next: z.string().max(2_000).optional(),
});

const loginThrottle = new OperatorLoginThrottle();
const globalLoginThrottle = new OperatorLoginThrottle({
  limit: 100,
  windowMs: 15 * 60_000,
});

function loginSource(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

function redirectResponse(request: Request, path: string): Response {
  return mutableRedirect(new URL(path, request.url), 303);
}

function setSessionCookie(
  response: Response,
  request: Request,
  value: string,
  maxAge: number,
): void {
  const secure = operatorCookieSecure(request) ? "; Secure" : "";
  response.headers.append(
    "Set-Cookie",
    `${OPERATOR_SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
  );
  response.headers.set("Cache-Control", "no-store");
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const intent = formData.get("intent");
  if (intent === "logout") {
    const session = verifyOperatorSession(
      cookieValue(request, OPERATOR_SESSION_COOKIE),
    );
    const csrf = formData.get("csrf");
    if (
      !session ||
      !verifyCsrfToken(session, typeof csrf === "string" ? csrf : null)
    ) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const response = redirectResponse(request, "/login");
    setSessionCookie(response, request, "", 0);
    return response;
  }

  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") || undefined,
  });
  const source = loginSource(request);
  const throttle = loginThrottle.check(source);
  const globalThrottle = globalLoginThrottle.check("all-sources");
  if (!throttle.allowed || !globalThrottle.allowed) {
    const retryAfterSeconds = !throttle.allowed
      ? throttle.retryAfterSeconds
      : globalThrottle.allowed
        ? 1
        : globalThrottle.retryAfterSeconds;
    return Response.json(
      { error: "Too many login attempts" },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      },
    );
  }
  const next = safeOperatorRedirect(parsed.success ? parsed.data.next : null);
  if (
    !parsed.success ||
    !verifyOperatorCredentials(parsed.data.email, parsed.data.password)
  ) {
    loginThrottle.recordFailure(source);
    globalLoginThrottle.recordFailure("all-sources");
    const destination = new URL("/login", request.url);
    destination.searchParams.set("error", "invalid_credentials");
    destination.searchParams.set("next", next);
    return mutableRedirect(destination, 303);
  }
  loginThrottle.recordSuccess(source);
  let token: string;
  try {
    token = createOperatorSession().token;
  } catch {
    return Response.json(
      { error: "Operator authentication is not configured" },
      { status: 503 },
    );
  }
  const response = redirectResponse(request, next);
  setSessionCookie(response, request, token, OPERATOR_SESSION_TTL_SECONDS);
  return response;
}
