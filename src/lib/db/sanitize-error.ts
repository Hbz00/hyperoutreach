function readStringProperty(
  value: unknown,
  property: "name" | "code" | "message",
): string | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return undefined;
  }
  try {
    const candidate = Reflect.get(value, property);
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redactMessage(message: string, secrets: readonly string[]): string {
  let sanitized = message;
  for (const secret of secrets) {
    if (secret) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED_DATABASE_URL]");
    }
  }
  return sanitized
    .replace(/postgres(?:ql)?:\/\/[^\s'"\])]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(
      /\b(password|token|secret|api[_-]?key)=([^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 500);
}

export function sanitizeDatabaseError(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  const rawMessage = readStringProperty(error, "message");
  if (!rawMessage) {
    return "DatabaseError: Unknown database error";
  }

  const rawName = readStringProperty(error, "name") ?? "DatabaseError";
  const name = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(rawName)
    ? rawName
    : "DatabaseError";
  const rawCode = readStringProperty(error, "code");
  const sqlState =
    rawCode && /^[0-9A-Z]{5}$/.test(rawCode) ? rawCode : undefined;
  const message =
    redactMessage(rawMessage, secrets) || "Unknown database error";

  return `${name}${sqlState ? ` [SQLSTATE ${sqlState}]` : ""}: ${message}`;
}
