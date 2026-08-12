export function mutableRedirect(
  destination: string | URL,
  status: 301 | 302 | 303 | 307 | 308 = 303,
): Response {
  return new Response(null, {
    status,
    headers: { Location: destination.toString() },
  });
}
