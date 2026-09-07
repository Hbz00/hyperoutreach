import { request as httpRequest } from "node:http";

import { expect, test } from "@playwright/test";

function postChunks(url: string, prefix: string, paddingBytes: number) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        // Early refusal can close a socket with upload bytes still in flight.
        // These transport probes must not return it to the shared HTTP agent.
        agent: false,
        headers: { "Content-Type": "application/json" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          request.destroy();
          resolve({ status: response.statusCode!, body });
        });
      },
    );
    request.once("error", reject);
    request.setTimeout(15_000, () =>
      request.destroy(new Error("Body-limit HTTP fixture timed out")),
    );
    request.write(prefix);
    const padding = Buffer.alloc(32 * 1024, 32);
    for (let sent = 0; sent < paddingBytes; sent += padding.length) {
      request.write(
        padding.subarray(0, Math.min(padding.length, paddingBytes - sent)),
      );
    }
    request.end();
  });
}

test("the assembled webhook rejects oversized chunked input even when its prefix is valid JSON", async ({
  baseURL,
}) => {
  // No Content-Length: this proves the route sees the real stream instead of
  // a proxy-truncated, valid JSON prefix. Empty notifications cannot trigger
  // any provider work, and the disposable server has only mock fixtures.
  const result = await postChunks(
    `${baseURL}/api/webhooks/microsoft`,
    '{"value":[]}',
    34 * 1024 * 1024,
  );
  expect(result.status).toBe(413);
  expect(result.body).toContain("Request body is too large");
});

test("the login route refuses an oversized advertised upload before waiting for its body", async ({
  baseURL,
}) => {
  const result = await new Promise<{ status: number; bodySent: boolean }>(
    (resolve, reject) => {
      let bodySent = false;
      const request = httpRequest(
        `${baseURL}/api/operator/session`,
        {
          method: "POST",
          agent: false,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": String(128 * 1024),
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            clearTimeout(fallback);
            resolve({ status: response.statusCode!, bodySent });
            request.destroy();
          });
        },
      );
      // If a regressed proxy waits for the upload, release it and fail the
      // bodySent oracle rather than leaving either client or server hanging.
      const fallback = setTimeout(() => {
        bodySent = true;
        request.end(Buffer.alloc(128 * 1024, 65));
      }, 1_000);
      request.once("error", (error) => {
        clearTimeout(fallback);
        reject(error);
      });
      request.setTimeout(5_000, () =>
        request.destroy(new Error("Header refusal fixture timed out")),
      );
      request.flushHeaders();
    },
  );
  expect(result).toEqual({ status: 413, bodySent: false });
});
