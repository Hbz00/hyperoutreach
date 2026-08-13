import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptionKeyring = {
  activeKeyId: string;
  keys: Record<string, Buffer>;
};

const ENVELOPE_VERSION = "v1";

export function encryptSecret(
  plaintext: string,
  keyring: EncryptionKeyring,
): string {
  const key = keyring.keys[keyring.activeKeyId];
  if (!key || key.length !== 32) {
    throw new Error("Active token encryption key must contain 32 bytes");
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
  const keys: Record<string, Buffer> = {};
  for (const entry of serialized.split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) throw new Error("Invalid token encryption keyring");
    const id = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    const key = Buffer.from(encoded, "base64");
    if (!id || key.length !== 32) {
      throw new Error("Every token encryption key must be 32 bytes");
    }
    keys[id] = key;
  }
  if (!keys[activeKeyId]) {
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
    const [version, keyId, nonceValue, ciphertextValue, tagValue, extra] =
      envelope.split(".");
    if (
      version !== ENVELOPE_VERSION ||
      !keyId ||
      !nonceValue ||
      !ciphertextValue ||
      !tagValue ||
      extra
    ) {
      throw new Error("invalid envelope");
    }
    const key = keyring.keys[keyId];
    if (!key || key.length !== 32) throw new Error("unknown key");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(nonceValue, "base64url"),
    );
    decipher.setAAD(Buffer.from(`${version}:${keyId}`));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
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
