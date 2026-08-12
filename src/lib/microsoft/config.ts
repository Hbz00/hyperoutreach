import { createHash } from "node:crypto";

import { z } from "zod";

import type { EncryptionKeyring } from "@/lib/microsoft/token-crypto";

export const MICROSOFT_DELEGATED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Mail.ReadWrite",
  "Mail.Send",
] as const;

const environmentSchema = z.object({
  MICROSOFT_CLIENT_ID: z.string().trim().min(1),
  MICROSOFT_CLIENT_SECRET: z.string().trim().min(1),
  MICROSOFT_TENANT_ID: z.string().trim().min(1).default("organizations"),
  MICROSOFT_REDIRECT_URI: z.url().refine((url) => {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.hostname === "localhost";
  }),
  MICROSOFT_GRAPH_WEBHOOK_CLIENT_STATE: z.string().min(32).max(128),
  TOKEN_ENCRYPTION_KEYS: z.string().trim().min(1),
  TOKEN_ENCRYPTION_ACTIVE_KEY_ID: z.string().trim().min(1),
});

export type MicrosoftConfig = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
  webhookClientState: string;
  keyring: EncryptionKeyring;
  authorizeEndpoint: string;
  tokenEndpoint: string;
};

export class MicrosoftConfigurationError extends Error {
  override readonly name = "MicrosoftConfigurationError";
}

function parseKeyring(
  serialized: string,
  activeKeyId: string,
): EncryptionKeyring {
  const keys: Record<string, Buffer> = {};
  for (const entry of serialized.split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0)
      throw new MicrosoftConfigurationError("Invalid token encryption keyring");
    const id = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    const key = Buffer.from(encoded, "base64");
    if (!id || key.length !== 32) {
      throw new MicrosoftConfigurationError(
        "Every token encryption key must be 32 bytes",
      );
    }
    keys[id] = key;
  }
  if (!keys[activeKeyId]) {
    throw new MicrosoftConfigurationError(
      "Active token encryption key is missing from keyring",
    );
  }
  return { activeKeyId, keys };
}

export function requireMicrosoftConfig(
  environment: Record<string, string | undefined>,
): MicrosoftConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new MicrosoftConfigurationError(
      "Microsoft Graph configuration is incomplete or invalid",
    );
  }
  const tenant = encodeURIComponent(parsed.data.MICROSOFT_TENANT_ID);
  return {
    clientId: parsed.data.MICROSOFT_CLIENT_ID,
    clientSecret: parsed.data.MICROSOFT_CLIENT_SECRET,
    tenantId: parsed.data.MICROSOFT_TENANT_ID,
    redirectUri: parsed.data.MICROSOFT_REDIRECT_URI,
    webhookClientState: parsed.data.MICROSOFT_GRAPH_WEBHOOK_CLIENT_STATE,
    keyring: parseKeyring(
      parsed.data.TOKEN_ENCRYPTION_KEYS,
      parsed.data.TOKEN_ENCRYPTION_ACTIVE_KEY_ID,
    ),
    authorizeEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  };
}

export function buildMicrosoftAuthorizationRequest(
  config: MicrosoftConfig,
  input: { state: string; codeVerifier: string },
): { authorizationUrl: string; codeChallenge: string } {
  const codeChallenge = createHash("sha256")
    .update(input.codeVerifier)
    .digest("base64url");
  const url = new URL(config.authorizeEndpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    response_mode: "query",
    scope: MICROSOFT_DELEGATED_SCOPES.join(" "),
    state: input.state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { authorizationUrl: url.toString(), codeChallenge };
}
