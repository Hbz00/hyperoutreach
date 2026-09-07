import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({
  getDatabase: () => {
    throw new Error("Unexpected database use in body refusal test");
  },
}));
vi.mock("@/lib/microsoft/server", () => ({
  getMicrosoftServerContext: () => {
    throw new Error("Unexpected Graph context in body refusal test");
  },
}));

import { POST as sessionPost } from "@/app/api/operator/session/route";
import { POST as commandPost } from "@/app/api/operator/commands/[command]/route";
import { POST as webhookPost } from "@/app/api/webhooks/microsoft/route";
import {
  createOperatorSession,
  OPERATOR_SESSION_COOKIE,
} from "@/lib/operator-auth";

beforeEach(() => {
  vi.stubEnv("OPERATOR_EMAIL", "body-fixture@example.test");
  vi.stubEnv("OPERATOR_PASSWORD", "synthetic-body-fixture-password");
  vi.stubEnv("SESSION_SECRET", "body-fixture-session-secret-at-least-32-chars");
});
afterEach(() => vi.unstubAllEnvs());

function streamedRequest(
  path: string,
  bytes: number,
  contentType: string,
  headers: Record<string, string> = {},
) {
  let produced = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (produced === bytes) {
          controller.close();
          return;
        }
        const size = Math.min(64 * 1024, bytes - produced);
        produced += size;
        controller.enqueue(new Uint8Array(size).fill(65));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const request = new Request(`http://operator.local${path}`, {
    method: "POST",
    body,
    duplex: "half",
    headers: { "content-type": contentType, ...headers },
  } as RequestInit);
  return { request, produced: () => produced, cancel };
}

describe("HTTP body limits at real route entrypoints", () => {
  it("refuses an oversized public login form while it is still streaming", async () => {
    const input = streamedRequest(
      "/api/operator/session",
      128 * 1024,
      "application/x-www-form-urlencoded",
    );
    expect((await sessionPost(input.request)).status).toBe(413);
    expect(input.produced()).toBeLessThan(128 * 1024);
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized authenticated command before CSRF/form parsing or database work", async () => {
    const { token } = createOperatorSession();
    const input = streamedRequest(
      "/api/operator/commands/create-prospect",
      2 * 1024 * 1024,
      "application/x-www-form-urlencoded",
      { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
    );
    expect(
      (
        await commandPost(input.request, {
          params: Promise.resolve({ command: "create-prospect" }),
        })
      ).status,
    ).toBe(413);
    expect(input.produced()).toBeLessThan(2 * 1024 * 1024);
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized public webhook before Graph context or parsing", async () => {
    const input = streamedRequest(
      "/api/webhooks/microsoft",
      34 * 1024 * 1024,
      "application/json",
    );
    expect((await webhookPost(input.request)).status).toBe(413);
    expect(input.produced()).toBeLessThan(34 * 1024 * 1024);
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses an advertised oversize without pulling the body", async () => {
    const input = streamedRequest(
      "/api/operator/session",
      1,
      "application/x-www-form-urlencoded",
      { "content-length": "999999999" },
    );
    expect((await sessionPost(input.request)).status).toBe(413);
    expect(input.produced()).toBe(0);
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not consume an unauthenticated command body", async () => {
    const input = streamedRequest(
      "/api/operator/commands/create-prospect",
      10,
      "application/x-www-form-urlencoded",
    );
    expect(
      (
        await commandPost(input.request, {
          params: Promise.resolve({ command: "create-prospect" }),
        })
      ).status,
    ).toBe(401);
    expect(input.produced()).toBe(0);
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves malformed login and webhook rejection and subscription validation", async () => {
    expect(
      (
        await sessionPost(
          new Request("http://operator.local/api/operator/session", {
            method: "POST",
            body: "not a form",
            headers: { "content-type": "text/plain" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await webhookPost(
          new Request("http://operator.local/api/webhooks/microsoft", {
            method: "POST",
            body: "not json",
            headers: { "content-type": "application/json" },
          }),
        )
      ).status,
    ).toBe(400);
    const validation = await webhookPost(
      new Request(
        "http://operator.local/api/webhooks/microsoft?validationToken=fixture-token",
        { method: "POST" },
      ),
    );
    expect(validation.status).toBe(200);
    expect(await validation.text()).toBe("fixture-token");
  });
});
