import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const MAX_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 45_000;
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");

/** Conservative public-unicast policy; mapped/translated and tunnel IPs fail. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6")
  );
}

async function publicAddress(hostname: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new Error("Non-public page address");
    return { address: host, family: isIP(host) };
  }
  // lookup itself cannot be cancelled; a late result cannot create a request.
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    lookup(host, { all: true, verbatim: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
  signal.throwIfAborted();
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error("Non-public page DNS answer");
  }
  return addresses[0]!;
}

async function readPage(url: URL, signal: AbortSignal, maxBytes: number) {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid public page URL");
  const pinned = await publicAddress(url.hostname, signal);
  return await new Promise<{ redirect?: string; body?: Buffer; pdf?: boolean }>(
    (resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          signal,
          agent: false,
          headers: {
            "user-agent": "Mozilla/5.0",
            "accept-encoding": "identity",
          },
          // Pin the validated address while preserving the URL's Host and TLS name.
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const redirect = response.headers.location;
            response.destroy();
            if (!redirect) reject(new Error("Missing page redirect"));
            else resolve({ redirect });
            return;
          }
          const encoding = response.headers["content-encoding"];
          const declaredLength = Number(response.headers["content-length"]);
          if (
            status < 200 ||
            status >= 300 ||
            (encoding && encoding !== "identity") ||
            declaredLength > maxBytes
          ) {
            response.destroy();
            reject(new Error("Unreadable page response"));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              response.destroy(new Error("Page body exceeds byte limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("aborted", () =>
            reject(new Error("Page response aborted")),
          );
          response.on("end", () =>
            resolve({
              body: Buffer.concat(chunks),
              pdf:
                (response.headers["content-type"] ?? "").includes("pdf") ||
                url.pathname.toLowerCase().endsWith(".pdf"),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    },
  );
}

/** One deadline covers DNS, redirects, body reading and the PDF child. */
export async function readPublicPage(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? DEADLINE_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(
    () => controller.abort(new Error("Public page deadline exceeded")),
    timeoutMs,
  );
  let directory: string | undefined;
  try {
    let target = new URL(url);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const result = await readPage(target, controller.signal, maxBytes);
      if (result.redirect) {
        target = new URL(result.redirect, target);
        continue;
      }
      controller.signal.throwIfAborted();
      if (!result.body) return null;
      if (!result.pdf) return result.body.toString("utf8");
      directory = await mkdtemp(join(tmpdir(), "probe-pdf-"));
      const file = join(directory, "page.pdf");
      await writeFile(file, result.body, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const { stdout } = await promisify(execFile)("pdftotext", [file, "-"], {
        maxBuffer: maxBytes,
        timeout: Math.max(1, deadline - Date.now()),
        killSignal: "SIGKILL",
      });
      controller.signal.throwIfAborted();
      return stdout;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function containsEmailToken(text: string, email: string): boolean {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}.!#$%&'*+/=?^_\u0060{|}~@-])${escaped}(?![\\p{L}\\p{N}\\p{M}_@-]|\\.[\\p{L}\\p{N}\\p{M}_-])`,
    "iu",
  ).test(text);
}
