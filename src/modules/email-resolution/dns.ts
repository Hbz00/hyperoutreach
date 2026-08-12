import { resolveMx } from "node:dns/promises";

import { normalizeDomain } from "@/modules/prospects/normalization";

export type MxRecord = { exchange: string; priority: number };
export type MxResolution = { hasMx: boolean; records: MxRecord[] };

export interface DnsMxResolver {
  resolve(
    domain: string,
    options?: { signal?: AbortSignal },
  ): Promise<MxResolution>;
}

type ResolveMx = (domain: string) => Promise<MxRecord[]>;

export class DnsResolutionError extends Error {
  override readonly name = "DnsResolutionError";
}

export class NodeDnsMxResolver implements DnsMxResolver {
  constructor(private readonly lookup: ResolveMx = resolveMx) {}

  async resolve(
    rawDomain: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<MxResolution> {
    const domain = normalizeDomain(rawDomain);
    try {
      options.signal?.throwIfAborted();
      const records = (await this.lookup(domain))
        .map((record) => ({
          exchange: record.exchange.trim().toLocaleLowerCase("en-US"),
          priority: record.priority,
        }))
        .filter((record) => record.exchange !== "" && record.exchange !== ".")
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            left.exchange.localeCompare(right.exchange),
        );
      options.signal?.throwIfAborted();
      return { hasMx: records.length > 0, records };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : null;
      if (code === "ENODATA" || code === "ENOTFOUND") {
        return { hasMx: false, records: [] };
      }
      throw new DnsResolutionError("MX lookup failed", { cause: error });
    }
  }
}

export class MockDnsMxResolver implements DnsMxResolver {
  constructor(private readonly hasMx: boolean) {}

  async resolve(
    rawDomain: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<MxResolution> {
    options.signal?.throwIfAborted();
    const domain = normalizeDomain(rawDomain);
    return this.hasMx
      ? {
          hasMx: true,
          records: [{ exchange: `mx.${domain}`, priority: 10 }],
        }
      : { hasMx: false, records: [] };
  }
}
