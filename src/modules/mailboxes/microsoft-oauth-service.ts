import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  mailboxConnections,
  oauthAuthorizationRequests,
  stateTransitions,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { withActionLocks } from "@/lib/db/action-lock";
import {
  buildMicrosoftAuthorizationRequest,
  MICROSOFT_DELEGATED_SCOPES,
  type MicrosoftConfig,
} from "@/lib/microsoft/config";
import { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";
import { decryptSecret, encryptSecret } from "@/lib/microsoft/token-crypto";
import { normalizeEmail } from "@/modules/prospects/normalization";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().min(1).optional(),
});
const meSchema = z.object({
  id: z.string().min(1),
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string().min(1),
});
const callbackSchema = z.object({
  code: z.string().min(1).max(10_000),
  codeVerifier: z.string().min(43).max(128),
});
const stateSchema = z.object({
  state: z.string().min(32).max(1_000),
  operatorBinding: z.string().min(32).max(500),
});

type OAuthOptions = {
  fetcher?: typeof fetch;
  now?: Date;
  requestTimeoutMs?: number;
};

class OAuthTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super("Microsoft token exchange failed");
  }
}

class MicrosoftConsentError extends Error {
  constructor() {
    super("Microsoft consent lacks required mail scopes");
  }
}

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function operatorBindingHash(binding: string): string {
  return createHash("sha256").update(binding).digest("hex");
}

function scopeList(scope: string): string[] {
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}

function hasRequiredScopes(scopes: string[]): boolean {
  const lower = new Set(scopes.map((scope) => scope.toLowerCase()));
  return ["mail.readwrite", "mail.send"].every((scope) => lower.has(scope));
}

async function tokenRequest(
  config: MicrosoftConfig,
  body: URLSearchParams,
  fetcher: typeof fetch,
  requestTimeoutMs: number,
  fallbackScopes: readonly string[],
) {
  const response = await fetcher(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    let code: string | null = null;
    try {
      const raw = (await response.json()) as { error?: unknown };
      code = typeof raw.error === "string" ? raw.error : null;
    } catch {
      code = null;
    }
    throw new OAuthTokenError(response.status, code);
  }
  const token = tokenSchema.parse(await response.json());
  const grantedScopes = token.scope
    ? scopeList(token.scope)
    : [...fallbackScopes];
  if (!hasRequiredScopes(grantedScopes)) {
    throw new MicrosoftConsentError();
  }
  return { ...token, grantedScopes };
}

export async function beginMicrosoftAuthorization(
  db: AppDatabase,
  config: MicrosoftConfig,
  options: { now?: Date; ttlMs?: number; operatorBinding: string },
) {
  const now = options.now ?? new Date();
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(64).toString("base64url");
  const request = buildMicrosoftAuthorizationRequest(config, {
    state,
    codeVerifier,
  });
  await db.insert(oauthAuthorizationRequests).values({
    provider: "microsoft_graph",
    stateHash: stateHash(state),
    encryptedCodeVerifier: encryptSecret(codeVerifier, config.keyring),
    operatorBindingHash: operatorBindingHash(options.operatorBinding),
    redirectUri: config.redirectUri,
    expiresAt: new Date(now.getTime() + (options.ttlMs ?? 10 * 60_000)),
  });
  return { authorizationUrl: request.authorizationUrl, state };
}

export async function consumeMicrosoftAuthorizationState(
  db: AppDatabase,
  config: MicrosoftConfig,
  rawInput: unknown,
  now = new Date(),
): Promise<{ ok: true; codeVerifier: string } | { ok: false; code: string }> {
  const parsed = stateSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_STATE" };
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(oauthAuthorizationRequests)
      .where(
        and(
          eq(
            oauthAuthorizationRequests.stateHash,
            stateHash(parsed.data.state),
          ),
          eq(
            oauthAuthorizationRequests.operatorBindingHash,
            operatorBindingHash(parsed.data.operatorBinding),
          ),
          isNull(oauthAuthorizationRequests.consumedAt),
          gt(oauthAuthorizationRequests.expiresAt, now),
        ),
      )
      .limit(1);
    if (!request) return { ok: false, code: "INVALID_STATE" } as const;
    const [claimed] = await tx
      .update(oauthAuthorizationRequests)
      .set({ consumedAt: now })
      .where(
        and(
          eq(oauthAuthorizationRequests.id, request.id),
          isNull(oauthAuthorizationRequests.consumedAt),
        ),
      )
      .returning();
    if (!claimed) return { ok: false, code: "INVALID_STATE" } as const;
    try {
      return {
        ok: true,
        codeVerifier: decryptSecret(
          claimed.encryptedCodeVerifier,
          config.keyring,
        ).plaintext,
      } as const;
    } catch {
      return { ok: false, code: "INVALID_STATE" } as const;
    }
  });
}

export async function completeMicrosoftConnection(
  db: AppDatabase,
  config: MicrosoftConfig,
  rawInput: unknown,
  options: OAuthOptions = {},
) {
  const parsed = callbackSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" } as const;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? new Date();
  try {
    const token = await tokenRequest(
      config,
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code: parsed.data.code,
        redirect_uri: config.redirectUri,
        code_verifier: parsed.data.codeVerifier,
        scope: MICROSOFT_DELEGATED_SCOPES.join(" "),
      }),
      fetcher,
      options.requestTimeoutMs ?? 10_000,
      MICROSOFT_DELEGATED_SCOPES,
    );
    if (!token.refresh_token) {
      return { ok: false, code: "REFRESH_TOKEN_MISSING" } as const;
    }
    const meResponse = await fetcher(
      "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? 10_000),
      },
    );
    if (!meResponse.ok) throw new Error("Microsoft profile lookup failed");
    const me = meSchema.parse(await meResponse.json());
    const email = me.mail ?? me.userPrincipalName;
    const normalizedEmail = normalizeEmail(email);
    const grantedScopes = token.grantedScopes;
    const tokenExpiresAt = new Date(now.getTime() + token.expires_in * 1_000);
    return db.transaction(async (tx) => {
      const [existingIdentity] = await tx
        .select()
        .from(mailboxConnections)
        .where(
          and(
            eq(mailboxConnections.provider, "microsoft_graph"),
            eq(mailboxConnections.providerUserId, me.id),
          ),
        )
        .limit(1);
      const [existingEmail] = await tx
        .select()
        .from(mailboxConnections)
        .where(
          and(
            eq(mailboxConnections.provider, "microsoft_graph"),
            eq(mailboxConnections.normalizedEmail, normalizedEmail),
          ),
        )
        .limit(1);
      if (
        (existingIdentity &&
          existingEmail &&
          existingIdentity.id !== existingEmail.id) ||
        (existingEmail?.providerUserId &&
          existingEmail.providerUserId !== me.id)
      ) {
        return { ok: false, code: "IDENTITY_CONFLICT" } as const;
      }
      const existing = existingIdentity ?? existingEmail;
      const values = {
        provider: "microsoft_graph" as const,
        email,
        normalizedEmail,
        encryptedRefreshToken: encryptSecret(
          token.refresh_token!,
          config.keyring,
        ),
        accessTokenCiphertext: encryptSecret(
          token.access_token,
          config.keyring,
        ),
        tokenExpiresAt,
        grantedScopes,
        tenantId: config.tenantId,
        providerUserId: me.id,
        status: "available" as const,
        syncCursor: existing?.syncCursor ?? null,
        lastSyncedAt:
          existing?.lastSyncedAt ?? new Date(now.getTime() - 5 * 60_000),
      };
      const [mailbox] = existing
        ? await tx
            .update(mailboxConnections)
            .set(values)
            .where(eq(mailboxConnections.id, existing.id))
            .returning()
        : await tx.insert(mailboxConnections).values(values).returning();
      if (!mailbox) throw new Error("Mailbox persistence failed");
      await tx.insert(stateTransitions).values({
        entityType: "mailbox",
        entityId: mailbox.id,
        fromState: existing?.status ?? null,
        toState: "available",
        reason: existing ? "microsoft_reconnected" : "microsoft_connected",
        actor: "operator",
      });
      return { ok: true, mailbox } as const;
    });
  } catch {
    return { ok: false, code: "PROVIDER_ERROR" } as const;
  }
}

const inFlightRefreshes = new Map<string, Promise<string>>();

export async function getMicrosoftAccessToken(
  db: AppDatabase,
  config: MicrosoftConfig,
  mailboxId: string,
  options: OAuthOptions = {},
): Promise<string> {
  const existingPromise = inFlightRefreshes.get(mailboxId);
  if (existingPromise) return existingPromise;
  const operation = withActionLocks(
    db,
    [`microsoft-oauth-refresh:${mailboxId}`],
    (lockedDb) => refreshAccessToken(lockedDb, config, mailboxId, options),
  ).finally(() => inFlightRefreshes.delete(mailboxId));
  inFlightRefreshes.set(mailboxId, operation);
  return operation;
}

/**
 * The one place a `MicrosoftGraphClient` is wired to a mailbox's token
 * lifecycle. Every caller that needs a Graph client for a specific mailbox
 * (outbound provider, inbound source, webhook/maintenance flows) composes
 * it from here instead of re-deriving the same two lines.
 */
export function createMailboxGraphClient(
  db: AppDatabase,
  config: MicrosoftConfig,
  mailboxId: string,
): MicrosoftGraphClient {
  return new MicrosoftGraphClient({
    accessToken: () => getMicrosoftAccessToken(db, config, mailboxId),
  });
}

async function refreshAccessToken(
  db: AppDatabase,
  config: MicrosoftConfig,
  mailboxId: string,
  options: OAuthOptions,
): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? new Date();
  const [mailbox] = await db
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, mailboxId))
    .limit(1);
  if (
    !mailbox ||
    mailbox.provider !== "microsoft_graph" ||
    mailbox.status !== "available" ||
    !mailbox.encryptedRefreshToken
  ) {
    throw new Error("Microsoft mailbox is unavailable");
  }
  if (
    mailbox.accessTokenCiphertext &&
    mailbox.tokenExpiresAt &&
    mailbox.tokenExpiresAt.getTime() > now.getTime() + 60_000
  ) {
    return decryptSecret(mailbox.accessTokenCiphertext, config.keyring)
      .plaintext;
  }
  const refreshToken = decryptSecret(
    mailbox.encryptedRefreshToken,
    config.keyring,
  ).plaintext;
  const encryptedRefreshToken = mailbox.encryptedRefreshToken;
  try {
    const token = await tokenRequest(
      config,
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: MICROSOFT_DELEGATED_SCOPES.join(" "),
      }),
      fetcher,
      options.requestTimeoutMs ?? 10_000,
      mailbox.grantedScopes,
    );
    const currentRefreshToken = token.refresh_token ?? refreshToken;
    const [updated] = await db
      .update(mailboxConnections)
      .set({
        encryptedRefreshToken: encryptSecret(
          currentRefreshToken,
          config.keyring,
        ),
        accessTokenCiphertext: encryptSecret(
          token.access_token,
          config.keyring,
        ),
        tokenExpiresAt: new Date(now.getTime() + token.expires_in * 1_000),
        grantedScopes: token.grantedScopes,
        status: "available",
      })
      .where(
        and(
          eq(mailboxConnections.id, mailbox.id),
          eq(mailboxConnections.encryptedRefreshToken, encryptedRefreshToken),
        ),
      )
      .returning({ id: mailboxConnections.id });
    if (!updated) {
      throw new Error("Microsoft token rotation ownership changed");
    }
    return token.access_token;
  } catch (error) {
    if (
      (error instanceof OAuthTokenError && error.code === "invalid_grant") ||
      error instanceof MicrosoftConsentError
    ) {
      await db.transaction(async (tx) => {
        const [revoked] = await tx
          .update(mailboxConnections)
          .set({
            status: "revoked",
            encryptedRefreshToken: null,
            accessTokenCiphertext: null,
            tokenExpiresAt: null,
          })
          .where(
            and(
              eq(mailboxConnections.id, mailbox.id),
              eq(mailboxConnections.status, "available"),
              eq(
                mailboxConnections.encryptedRefreshToken,
                encryptedRefreshToken,
              ),
            ),
          )
          .returning({ id: mailboxConnections.id });
        if (revoked) {
          await tx.insert(stateTransitions).values({
            entityType: "mailbox",
            entityId: mailbox.id,
            fromState: "available",
            toState: "revoked",
            reason:
              error instanceof MicrosoftConsentError
                ? "microsoft_required_consent_missing"
                : "microsoft_refresh_invalid_grant",
            actor: "system",
          });
        }
      });
    }
    throw error;
  }
}

export async function disconnectMicrosoftMailbox(
  db: AppDatabase,
  mailboxId: string,
  options: {
    deleteSubscription?: (subscriptionId: string) => Promise<void>;
  } = {},
) {
  const [mailbox] = await db
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, mailboxId))
    .limit(1);
  if (!mailbox || mailbox.provider !== "microsoft_graph") {
    return { ok: false, code: "NOT_FOUND" } as const;
  }
  let remoteDeleteFailed = false;
  if (mailbox.subscriptionId && options.deleteSubscription) {
    try {
      await options.deleteSubscription(mailbox.subscriptionId);
    } catch {
      remoteDeleteFailed = true;
    }
  }
  await db.transaction(async (tx) => {
    await tx
      .update(mailboxConnections)
      .set({
        status: "disconnected",
        encryptedRefreshToken: null,
        accessTokenCiphertext: null,
        tokenExpiresAt: null,
        grantedScopes: [],
        syncCursor: null,
        subscriptionId: null,
        subscriptionExpiresAt: null,
        subscriptionClientStateHash: null,
        subscriptionResource: null,
      })
      .where(eq(mailboxConnections.id, mailbox.id));
    await tx.insert(stateTransitions).values({
      entityType: "mailbox",
      entityId: mailbox.id,
      fromState: mailbox.status,
      toState: "disconnected",
      reason: remoteDeleteFailed
        ? "microsoft_disconnected_remote_delete_failed"
        : "microsoft_disconnected",
      actor: "operator",
    });
  });
  return { ok: true, remoteDeleteFailed } as const;
}
