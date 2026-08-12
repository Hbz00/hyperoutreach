import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OPERATOR_SESSION_COOKIE = "hyperoutreach_session";
export const OPERATOR_SESSION_TTL_SECONDS = 12 * 60 * 60;

export type OperatorSession = {
  email: string;
  csrfToken: string;
  issuedAt: number;
  expiresAt: number;
};

type SignedOperatorSession = Omit<OperatorSession, "email"> & {
  subject: "operator";
};

function equalSecret(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionConfiguration(
  environment: Record<string, string | undefined>,
): { email: string; password: string; secret: string } | null {
  const email = environment.OPERATOR_EMAIL?.trim().toLowerCase();
  const password = environment.OPERATOR_PASSWORD;
  const secret = environment.SESSION_SECRET;
  if (
    !email ||
    !password ||
    password.length < 12 ||
    !secret ||
    secret.length < 32
  ) {
    return null;
  }
  return { email, password, secret };
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

export function verifyOperatorCredentials(
  email: string,
  password: string,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const configured = sessionConfiguration(environment);
  if (!configured) return false;
  const emailMatches = equalSecret(
    email.trim().toLowerCase(),
    configured.email,
  );
  const passwordMatches = equalSecret(password, configured.password);
  return emailMatches && passwordMatches;
}

export function createOperatorSession(
  environment: Record<string, string | undefined> = process.env,
  options: {
    now?: Date;
    ttlSeconds?: number;
    csrfToken?: string;
  } = {},
): { token: string; session: OperatorSession } {
  const configured = sessionConfiguration(environment);
  if (!configured) throw new Error("Operator session is not configured");
  const now = options.now ?? new Date();
  const ttlSeconds = options.ttlSeconds ?? OPERATOR_SESSION_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60) {
    throw new Error("Invalid session lifetime");
  }
  const signedSession: SignedOperatorSession = {
    subject: "operator",
    csrfToken: options.csrfToken ?? randomBytes(32).toString("base64url"),
    issuedAt: Math.floor(now.getTime() / 1_000),
    expiresAt: Math.floor(now.getTime() / 1_000) + ttlSeconds,
  };
  const session: OperatorSession = {
    email: configured.email,
    ...signedSession,
  };
  const payload = Buffer.from(JSON.stringify(signedSession)).toString(
    "base64url",
  );
  return { token: `${payload}.${sign(payload, configured.secret)}`, session };
}

export function verifyOperatorSession(
  token: string | null | undefined,
  environment: Record<string, string | undefined> = process.env,
  options: { now?: Date } = {},
): OperatorSession | null {
  const configured = sessionConfiguration(environment);
  if (!configured || !token) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const receivedSignature = token.slice(separator + 1);
  const expectedSignature = sign(payload, configured.secret);
  if (!equalSecret(receivedSignature, expectedSignature)) return null;
  try {
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<SignedOperatorSession>;
    const nowSeconds = Math.floor(
      (options.now ?? new Date()).getTime() / 1_000,
    );
    if (
      value.subject !== "operator" ||
      typeof value.csrfToken !== "string" ||
      value.csrfToken.length < 24 ||
      typeof value.issuedAt !== "number" ||
      typeof value.expiresAt !== "number" ||
      value.issuedAt > nowSeconds + 60 ||
      value.expiresAt <= nowSeconds ||
      value.expiresAt <= value.issuedAt
    ) {
      return null;
    }
    return { email: configured.email, ...(value as SignedOperatorSession) };
  } catch {
    return null;
  }
}

export function verifyCsrfToken(
  session: OperatorSession,
  received: string | null | undefined,
): boolean {
  return (
    typeof received === "string" && equalSecret(received, session.csrfToken)
  );
}

export function authorizeOperatorRequest(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): "authorized" | "unauthorized" | "unconfigured" {
  const expected = environment.OPERATOR_API_TOKEN;
  if (!expected || expected.length < 32) return "unconfigured";
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return "unauthorized";
  return equalSecret(header.slice(7), expected) ? "authorized" : "unauthorized";
}

export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function operatorCookieSecure(
  request: Request,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (environment.OPERATOR_COOKIE_SECURE === "false") return false;
  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  return (
    forwarded === "https" ||
    new URL(request.url).protocol === "https:" ||
    environment.NODE_ENV === "production"
  );
}

export function safeOperatorRedirect(
  value: string | null | undefined,
  fallback = "/",
): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  try {
    const base = new URL("http://operator.local");
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin || value.includes("\\"))
      return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}
