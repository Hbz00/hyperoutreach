import { NextResponse, type NextRequest } from "next/server";

import {
  authorizeOperatorRequest,
  OPERATOR_SESSION_COOKIE,
  verifyOperatorSession,
} from "@/lib/operator-auth";
import { isPublicOperatorPath } from "@/lib/operator-route-policy";

export function applyOperatorProxy(
  request: NextRequest,
  environment: Record<string, string | undefined>,
) {
  const pathname = request.nextUrl.pathname;
  if (isPublicOperatorPath(pathname)) return NextResponse.next();

  const session = verifyOperatorSession(
    request.cookies.get(OPERATOR_SESSION_COOKIE)?.value,
    environment,
  );
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    if (authorizeOperatorRequest(request, environment) === "authorized") {
      return NextResponse.next();
    }
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export function proxy(request: NextRequest) {
  return applyOperatorProxy(request, process.env);
}

export const config = {
  matcher: [
    "/((?!_next/image|_next/static|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
