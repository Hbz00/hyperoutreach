import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptionKeyring = {
  activeKeyId: string;
  keys: Record<string, Buffer>;
};

const ENVELOPE_VERSION = "v1";

function validKeyId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && !/[.,:]/.test(id);
}

export function encryptSecret(
  plaintext: string,
  keyring: EncryptionKeyring,
): string {
  if (!validKeyId(keyring.activeKeyId)) {
    throw new Error("Invalid token encryption key ID");
  }
  const key = keyring.keys[keyring.activeKeyId];
  if (
    !Object.hasOwn(keyring.keys, keyring.activeKeyId) ||
    !Buffer.isBuffer(key) ||
    key.length !== 32
  ) {
    throw new Error("Active token encryption key must contain 32 bytes");
  }
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Secret to encrypt must be a nonempty string");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${ENVELOPE_VERSION}:${keyring.activeKeyId}`));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    ENVELOPE_VERSION,
    keyring.activeKeyId,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

/**
 * Parses the `key-id:base64(32 bytes)[,key-id:base64(32 bytes)...]` keyring
 * format shared by every consumer of `encryptSecret`/`decryptSecret` — Graph
 * refresh/access tokens (`lib/microsoft/config.ts`) and the `smtp_imap`
 * mailbox password (`provider-bootstrap.ts`) alike. Lives here, next to the
 * type and the encrypt/decrypt functions it feeds, rather than duplicated
 * per caller — "même mécanisme, aucun code de chiffrement nouveau" (design
 * doc §6).
 */
export function parseEncryptionKeyring(
  serialized: string,
  activeKeyId: string,
): EncryptionKeyring {
  if (!validKeyId(activeKeyId)) {
    throw new Error("Invalid token encryption key ID");
  }
  const keys: Record<string, Buffer> = Object.create(null);
  for (const entry of serialized.split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) throw new Error("Invalid token encryption keyring");
    const id = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (!validKeyId(id) || Object.hasOwn(keys, id)) {
      throw new Error("Invalid or duplicate token encryption key ID");
    }
    const key = Buffer.from(encoded, "base64");
    // Node's decoder ignores invalid characters. Accept standard/base64url
    // alphabets and optional padding only when the complete value matches.
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const canonical = key.toString("base64");
    if (
      key.length !== 32 ||
      (normalized !== canonical && normalized !== canonical.replace(/=$/, ""))
    ) {
      throw new Error("Every token encryption key must be 32 bytes");
    }
    keys[id] = key;
  }
  if (!Object.hasOwn(keys, activeKeyId)) {
    throw new Error("Active token encryption key is missing from keyring");
  }
  return { activeKeyId, keys };
}

/**
 * Reads `TOKEN_ENCRYPTION_KEYS`/`TOKEN_ENCRYPTION_ACTIVE_KEY_ID` straight
 * out of an environment object and builds the keyring — independent of
 * `MicrosoftConfig`/`requireMicrosoftConfig`, which additionally demands
 * `MICROSOFT_CLIENT_ID` and friends. A provider that needs nothing but this
 * keyring (the `smtp_imap` mailbox password) must not be forced through
 * Microsoft-specific validation to get it — see the design doc §5's lazy
 * per-provider config resolution.
 */
export function requireTokenEncryptionKeyring(
  environment: Record<string, string | undefined>,
): EncryptionKeyring {
  const serialized = environment.TOKEN_ENCRYPTION_KEYS;
  const activeKeyId = environment.TOKEN_ENCRYPTION_ACTIVE_KEY_ID;
  if (!serialized || !activeKeyId) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEYS and TOKEN_ENCRYPTION_ACTIVE_KEY_ID are required",
    );
  }
  return parseEncryptionKeyring(serialized, activeKeyId);
}

export function decryptSecret(
  envelope: string,
  keyring: EncryptionKeyring,
): { plaintext: string; keyId: string; needsRotation: boolean } {
  try {
    const parts = envelope.split(".");
    const [version, keyId, nonceValue, ciphertextValue, tagValue] = parts;
    if (
      parts.length !== 5 ||
      version !== ENVELOPE_VERSION ||
      !keyId ||
      !nonceValue ||
      !ciphertextValue ||
      !tagValue
    ) {
      throw new Error("invalid envelope");
    }
    const key = keyring.keys[keyId];
    if (
      !Object.hasOwn(keyring.keys, keyId) ||
      !Buffer.isBuffer(key) ||
      key.length !== 32
    ) {
      throw new Error("unknown key");
    }
    const nonce = Buffer.from(nonceValue, "base64url");
    const ciphertext = Buffer.from(ciphertextValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    if (
      nonce.length !== 12 ||
      tag.length !== 16 ||
      nonce.toString("base64url") !== nonceValue ||
      ciphertext.toString("base64url") !== ciphertextValue ||
      tag.toString("base64url") !== tagValue
    ) {
      throw new Error("invalid envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`${version}:${keyId}`));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return {
      plaintext,
      keyId,
      needsRotation: keyId !== keyring.activeKeyId,
    };
  } catch {
    throw new Error("Encrypted secret could not be authenticated");
  }
}
