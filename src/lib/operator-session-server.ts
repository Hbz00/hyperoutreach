import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  OPERATOR_SESSION_COOKIE,
  type OperatorSession,
  verifyCsrfToken,
  verifyOperatorSession,
} from "@/lib/operator-auth";

export async function getOperatorSession(): Promise<OperatorSession | null> {
  const token = (await cookies()).get(OPERATOR_SESSION_COOKIE)?.value;
  return verifyOperatorSession(token);
}

export async function requireOperatorSession(): Promise<OperatorSession> {
  const session = await getOperatorSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireOperatorMutation(
  formData: FormData,
): Promise<OperatorSession> {
  const session = await getOperatorSession();
  if (!session) throw new Error("Unauthorized");
  const csrf = formData.get("csrf");
  if (!verifyCsrfToken(session, typeof csrf === "string" ? csrf : null)) {
    throw new Error("Forbidden");
  }
  return session;
}
