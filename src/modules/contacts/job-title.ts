import { normalizeCompanyName } from "@/modules/prospects/normalization";

/** Accent- and case-folded words, punctuation dropped. */
function words(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The one brand token to look for inside a title: the domain's first label when
 * there is a domain, otherwise the longest word of the account name.
 *
 * One anchor rather than every word of the name, and that is the load-bearing
 * choice. "Directeur Régional des Opérations - région Hauts de France" is a real
 * title at the account "FedEx Express France"; a rule keyed on the name's words
 * would find `france`, cut at the hyphen, and delete the half of the title that
 * carries the information. The domain label also catches what the full name
 * misses — six live rows name the employer as "FedEx", "FedEx Express" or
 * "FedEx Express FR", and only one writes it out in full.
 */
function employerAnchor(account: {
  name: string;
  domain: string | null;
}): string | null {
  const fromDomain = account.domain
    ? words(account.domain.split(".")[0] ?? "").join("")
    : "";
  if (fromDomain.length >= 3) return fromDomain;
  const longest = [...words(normalizeCompanyName(account.name))].sort(
    (left, right) => right.length - left.length,
  )[0];
  return longest && longest.length >= 3 ? longest : null;
}

/**
 * Whether the anchor appears as one word, or as a run of consecutive words.
 *
 * The run form is what matches "Mondial Relay" against the domain label
 * `mondialrelay`.
 */
function mentions(value: string, anchor: string): boolean {
  const parts = words(value);
  for (let start = 0; start < parts.length; start += 1) {
    let joined = "";
    for (let end = start; end < parts.length; end += 1) {
      joined += parts[end];
      if (joined === anchor) return true;
      if (joined.length >= anchor.length) break;
    }
  }
  return false;
}

/** What separates a title from the employer clause that follows it. */
const CONNECTOR = /\s+chez\s+|\s+at\s+|\s+for\s+|\s*@|\s*[|·–—-]\s*|\s*,\s*/giu;
const TRAILING = /[\s,|·–—-]+$/u;
const MINIMUM_TITLE_LENGTH = 3;

/**
 * A profile headline with its employer clause removed, or the title unchanged.
 *
 * Contact discovery persists whatever the model returned, and the model returns
 * what the profile says — "Directeur agence chez FedEx Express FR". The
 * employer inside the string is what made a template naming both the title and
 * the company print the company twice, and there is no screen anywhere that can
 * fix a stored title afterwards: the contact service returns an existing
 * contact unchanged, so resubmitting the form is a no-op. Cleaning before the
 * write is the only point at which this is repairable.
 *
 * Stripping rather than rejecting, deliberately. A rejected contact would
 * disappear with no explanation — the discovery conflict list is returned by
 * the service and rendered by nothing — leaving an operator to wonder why four
 * people came back instead of ten.
 *
 * `jobTitle: null` means the string was the employer's name and nothing else.
 * Generation already refuses a missing variable in words the operator can act
 * on, which is better than sending a company name as somebody's role.
 */
export function withoutEmployer(
  rawJobTitle: string,
  account: { name: string; domain: string | null },
): { jobTitle: string | null; employerRemoved: boolean } {
  const title = rawJobTitle.trim();
  const anchor = employerAnchor(account);
  if (!anchor || !mentions(title, anchor)) {
    return { jobTitle: title, employerRemoved: false };
  }
  // Last connector first, so the cut lands on the one the employer directly
  // follows. A title can hold a comma or a dash of its own, and the *first*
  // connector whose suffix happens to reach the employer is not the employer's
  // connector: "Directeur regional - Hauts de France chez FedEx" cut at the
  // dash and lost the region — the very truncation `employerAnchor` exists to
  // prevent, reintroduced one step later. Walking backwards, the last
  // connector whose suffix still names the employer is by construction the one
  // immediately before the employer clause.
  const connectors = [...title.matchAll(CONNECTOR)].filter(
    (match): match is RegExpExecArray & { index: number } =>
      match.index !== undefined,
  );
  for (const match of connectors.reverse()) {
    if (!mentions(title.slice(match.index), anchor)) continue;
    const head = title.slice(0, match.index).trim().replace(TRAILING, "");
    return {
      jobTitle: head.length >= MINIMUM_TITLE_LENGTH ? head : null,
      employerRemoved: true,
    };
  }
  // The employer is named with no connector at all ("FedEx Operations
  // Director"). Only here is dropping every word of the account name safe: the
  // anchor has already proved this string is about the employer.
  const employerWords = new Set([...words(account.name), anchor]);
  const kept = title
    .split(/\s+/)
    .filter((word) => {
      const [normalized] = words(word);
      return normalized !== undefined && !employerWords.has(normalized);
    })
    .join(" ")
    .trim()
    .replace(TRAILING, "");
  return {
    jobTitle: kept.length >= MINIMUM_TITLE_LENGTH ? kept : null,
    employerRemoved: true,
  };
}
