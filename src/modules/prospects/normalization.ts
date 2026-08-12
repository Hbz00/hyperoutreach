import { domainToASCII } from "node:url";

function normalizeWords(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeCompanyName(value: string): string {
  const normalized = normalizeWords(value).replace(
    /\b(?:[a-z0-9]\s){1,}[a-z0-9]\b/g,
    (acronym) => acronym.replaceAll(" ", ""),
  );
  if (!normalized) {
    throw new Error("Invalid company name");
  }
  return normalized;
}

export function normalizePersonName(value: string): string {
  const normalized = normalizeWords(value);
  if (!normalized) {
    throw new Error("Invalid person name");
  }
  return normalized;
}

export function normalizeDomain(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new Error("Invalid domain");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error("Invalid domain");
  }

  if (parsed.username || parsed.password || parsed.port) {
    throw new Error("Invalid domain");
  }

  const hostname = domainToASCII(parsed.hostname.toLowerCase()).replace(
    /^www\./,
    "",
  );
  const labels = hostname.split(".");
  const valid =
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );

  if (!valid || hostname.length > 253) {
    throw new Error("Invalid domain");
  }

  return hostname;
}

export function normalizeEmail(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("@");
  if (
    separator <= 0 ||
    separator !== trimmed.indexOf("@") ||
    separator === trimmed.length - 1 ||
    /\s/.test(trimmed)
  ) {
    throw new Error("Invalid email");
  }

  const localPart = trimmed.slice(0, separator).toLowerCase();
  if (
    localPart.length > 64 ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(localPart)
  ) {
    throw new Error("Invalid email");
  }

  try {
    return `${localPart}@${normalizeDomain(trimmed.slice(separator + 1))}`;
  } catch {
    throw new Error("Invalid email");
  }
}
