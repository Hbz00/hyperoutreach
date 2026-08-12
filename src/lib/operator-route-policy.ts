const PUBLIC_EXACT_PATHS = new Set([
  "/login",
  "/api/operator/session",
  "/api/health",
  "/api/webhooks/microsoft",
  "/api/integrations/microsoft/callback",
  "/favicon.ico",
]);

export function isPublicOperatorPath(pathname: string): boolean {
  return (
    PUBLIC_EXACT_PATHS.has(pathname) ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/icons/")
  );
}
