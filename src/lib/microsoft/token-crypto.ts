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
