import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKeyring,
  requireTokenEncryptionKeyring,
  type EncryptionKeyring,
} from "@/lib/microsoft/token-crypto";

const currentKey = Buffer.alloc(32, 7);
const previousKey = Buffer.alloc(32, 3);
const encodedKey = currentKey.toString("base64");

describe("token encryption configuration boundaries", () => {
  it.each(["key.v1", ".current", "current."])(
    "rejects envelope-delimiter key ID %j during configuration parsing",
    (activeKeyId) => {
      expect(() =>
        parseEncryptionKeyring(`${activeKeyId}:${encodedKey}`, activeKeyId),
      ).toThrow();
      expect(() =>
        requireTokenEncryptionKeyring({
          TOKEN_ENCRYPTION_KEYS: `${activeKeyId}:${encodedKey}`,
          TOKEN_ENCRYPTION_ACTIVE_KEY_ID: activeKeyId,
        }),
      ).toThrow();
    },
  );

  it.each(["", "key.v1", "key,v1", "key:v1"])(
    "rejects direct keyring ID %j before creating an envelope",
    (activeKeyId) => {
      expect(() =>
        encryptSecret("fixture-refresh-secret", {
          activeKeyId,
          keys: { [activeKeyId]: currentKey },
        }),
      ).toThrow();
    },
  );

  it("rejects a malformed inactive key ID before it can later become active", () => {
    expect(() =>
      parseEncryptionKeyring(
        `current:${encodedKey},previous.v1:${previousKey.toString("base64")}`,
        "current",
      ),
    ).toThrow();
  });

  it.each([currentKey, previousKey])(
    "rejects duplicate key IDs instead of silently replacing key material",
    (duplicateKey) => {
      expect(() =>
        parseEncryptionKeyring(
          `current:${encodedKey}, current :${duplicateKey.toString("base64")}`,
          "current",
        ),
      ).toThrow();
    },
  );

  it.each([
    `${encodedKey}!`,
    `!${encodedKey}`,
    `${encodedKey}=`,
    `${encodedKey.slice(0, 12)}!${encodedKey.slice(12)}`,
    `${encodedKey}ignored`,
  ])(
    "rejects malformed base64 instead of silently discarding characters",
    (key) => {
      expect(() =>
        parseEncryptionKeyring(`current:${key}`, "current"),
      ).toThrow();
    },
  );

  it("rejects active keys inherited through a direct keyring's prototype", () => {
    const inheritedKeys = Object.create({ current: currentKey }) as Record<
      string,
      Buffer
    >;
    expect(() =>
      encryptSecret("fixture-refresh-secret", {
        activeKeyId: "current",
        keys: inheritedKeys,
      }),
    ).toThrow();
  });

  it("does not confuse inherited object members with configured active keys", () => {
    expect(() =>
      parseEncryptionKeyring(`current:${encodedKey}`, "constructor"),
    ).toThrow();
  });

  it("rejects non-Buffer direct keys even when they contain 32 characters", () => {
    expect(() =>
      encryptSecret("fixture-refresh-secret", {
        activeKeyId: "current",
        keys: { current: "s".repeat(32) },
      } as unknown as EncryptionKeyring),
    ).toThrow();
  });

  it.each([
    encodedKey,
    encodedKey.replace(/=$/, ""),
    Buffer.alloc(32, 255).toString("base64"),
    Buffer.alloc(32, 255).toString("base64url"),
  ])(
    "preserves valid padded, unpadded and URL-safe key encodings",
    (encoded) => {
      const ring = parseEncryptionKeyring(` current : ${encoded} `, "current");
      expect(
        decryptSecret(encryptSecret("fixture-secret", ring), ring).plaintext,
      ).toBe("fixture-secret");
    },
  );

  it.each([
    "current",
    "prod-v1",
    "key_2026",
    "clé-v1",
    "key v1",
    "__proto__",
    "constructor",
  ])(
    "preserves valid key ID %j and marks previous-key envelopes for rotation",
    (activeKeyId) => {
      const ring = parseEncryptionKeyring(
        `${activeKeyId}:${encodedKey},previous:${previousKey.toString("base64")}`,
        activeKeyId,
      );
      expect(Object.hasOwn(ring.keys, activeKeyId)).toBe(true);
      const encrypted = encryptSecret("fixture-refresh-secret", ring);
      expect(encrypted.split(".")).toHaveLength(5);
      expect(decryptSecret(encrypted, ring)).toEqual({
        plaintext: "fixture-refresh-secret",
        keyId: activeKeyId,
        needsRotation: false,
      });
      const previous = encryptSecret("fixture-old-secret", {
        activeKeyId: "previous",
        keys: ring.keys,
      });
      expect(decryptSecret(previous, ring)).toEqual({
        plaintext: "fixture-old-secret",
        keyId: "previous",
        needsRotation: true,
      });
    },
  );
});

describe("token encryption envelope boundaries", () => {
  const ring: EncryptionKeyring = {
    activeKeyId: "current",
    keys: { current: currentKey },
  };

  it.each([
    {
      envelope:
        "v1.current.8dQ_I1VHG399LV9c.vArZ_7W-frVEPbMUEmTb5WZ7-eQ7WQ.wpXXrNJz7NI1AocaVYAgLw",
      plaintext: "fixture-legacy-current",
      keyId: "current",
      needsRotation: false,
    },
    {
      envelope:
        "v1.previous.T5vu4ZI6JJhu-87m.SrmFtUbqafcV3m3ZM9DXXK5_WtiKohI.qdmidv44QvSoeVhBJgUSdw",
      plaintext: "fixture-legacy-previous",
      keyId: "previous",
      needsRotation: true,
    },
  ])(
    "decrypts an unchanged pre-repair $keyId envelope",
    ({ envelope, ...expected }) => {
      // These immutable synthetic fixtures were emitted by the committed
      // pre-repair encryptSecret, independently of the implementation above.
      expect(
        decryptSecret(envelope, {
          activeKeyId: "current",
          keys: { current: currentKey, previous: previousKey },
        }),
      ).toEqual(expected);
    },
  );

  it("rejects an empty secret before producing an unreadable envelope", () => {
    expect(() => encryptSecret("", ring)).toThrow();
  });

  it.each([4, 8, 12, 13, 14, 15])(
    "rejects truncated %i-byte authentication tags",
    (bytes) => {
      const parts = encryptSecret("fixture-refresh-secret", ring).split(".");
      parts[4] = Buffer.from(parts[4]!, "base64url")
        .subarray(0, bytes)
        .toString("base64url");
      expect(() => decryptSecret(parts.join("."), ring)).toThrow(
        "Encrypted secret could not be authenticated",
      );
    },
  );

  it.each([".", "..", "..ignored", ".ignored"])(
    "rejects extra envelope segments %j",
    (suffix) => {
      const envelope = encryptSecret("fixture-refresh-secret", ring);
      expect(() => decryptSecret(envelope + suffix, ring)).toThrow(
        "Encrypted secret could not be authenticated",
      );
    },
  );

  it.each([2, 3, 4])("rejects junk in encoded envelope field %i", (field) => {
    const parts = encryptSecret("fixture-refresh-secret", ring).split(".");
    parts[field] = `!${parts[field]!}`;
    expect(() => decryptSecret(parts.join("."), ring)).toThrow(
      "Encrypted secret could not be authenticated",
    );
  });
});
