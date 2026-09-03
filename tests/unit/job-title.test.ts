import { describe, expect, it } from "vitest";

import { withoutEmployer } from "@/modules/contacts/job-title";

/**
 * Contact discovery reports whatever the profile said, and a profile headline
 * is not a job title. Ten contacts came back from a real run at one company and
 * six of them carried the employer inside the title — which is why a template
 * reading "{{job_title}} leaders at companies like {{company}}" named FedEx
 * twice and stopped being a sentence.
 *
 * The rows below are that run, verbatim. The four that must not change are as
 * load-bearing as the six that must: "Directeur Régional des Opérations -
 * région Hauts de France" is a real title at "FedEx Express France", and a rule
 * keyed on the words of the account name would cut it at the hyphen and delete
 * the half that carries the information.
 */
const fedex = { name: "FedEx Express France", domain: "fedex.com" };

describe("stripping the employer from a job title", () => {
  const carriesEmployer: Array<[string, string]> = [
    [
      "Directeur Général de l'Experience Client Chez FedEx Express France",
      "Directeur Général de l'Experience Client",
    ],
    ["Directeur des Opérations @FedEx Express FR", "Directeur des Opérations"],
    ["Directeur agence chez FedEx Express FR", "Directeur agence"],
    [
      "Responsable de la logistique en entrepôts chez FedEx",
      "Responsable de la logistique en entrepôts",
    ],
    [
      "Managing Director Ground Operations chez FedEx Express FR",
      "Managing Director Ground Operations",
    ],
    ["Directeur des opérations chez FedEx Express", "Directeur des opérations"],
  ];

  for (const [raw, expected] of carriesEmployer) {
    it(`removes the employer from "${raw}"`, () => {
      expect(withoutEmployer(raw, fedex)).toEqual({
        jobTitle: expected,
        employerRemoved: true,
      });
    });
  }

  const cleanTitles = [
    // The false positive that matters: "France" is a word of the account name
    // and a legitimate word of this title.
    "Directeur Régional des Opérations - région Hauts de France",
    "Director Planning & Engineering Europe – Ground Support Equipment",
    "Managing Director Transport Operations",
    "Directeur régional opérations",
  ];

  for (const raw of cleanTitles) {
    it(`leaves "${raw}" alone`, () => {
      expect(withoutEmployer(raw, fedex)).toEqual({
        jobTitle: raw,
        employerRemoved: false,
      });
    });
  }

  /**
   * A title carrying its own punctuation *and* an employer clause.
   *
   * The first connector whose suffix reaches the employer is not the
   * employer's connector, and cutting there deletes the qualifier — the exact
   * failure `employerAnchor` was written to avoid, one step further down. The
   * region in the third row is the same region the clean-title case above
   * protects; the only difference is that here an employer follows it.
   */
  const multipleConnectors: Array<[string, string]> = [
    ["Director for Europe at FedEx", "Director for Europe"],
    ["VP Sales - EMEA | FedEx", "VP Sales - EMEA"],
    [
      "Directeur régional - Hauts de France chez FedEx",
      "Directeur régional - Hauts de France",
    ],
    [
      "Directeur des opérations, Europe chez FedEx Express",
      "Directeur des opérations, Europe",
    ],
    ["Head of Ops | EMEA | FedEx Express FR", "Head of Ops | EMEA"],
  ];

  for (const [raw, expected] of multipleConnectors) {
    it(`cuts "${raw}" at the employer's own connector`, () => {
      expect(withoutEmployer(raw, fedex)).toEqual({
        jobTitle: expected,
        employerRemoved: true,
      });
    });
  }

  it("keeps an employer clause that itself holds a comma", () => {
    // Walking backwards must not stop at a connector *inside* the employer
    // clause: ", France" does not name the employer, so the cut falls back to
    // the "chez" that does.
    expect(
      withoutEmployer(
        "Directeur des opérations chez FedEx Express, France",
        fedex,
      ),
    ).toEqual({
      jobTitle: "Directeur des opérations",
      employerRemoved: true,
    });
  });

  it("matches an employer whose domain runs two words together", () => {
    expect(
      withoutEmployer("Head of Ops chez Mondial Relay", {
        name: "Mondial Relay",
        domain: "mondialrelay.fr",
      }),
    ).toEqual({ jobTitle: "Head of Ops", employerRemoved: true });
  });

  it("answers null when nothing but the employer was there", () => {
    // Persisting "FedEx" as somebody's job title is worse than persisting
    // nothing: generation already refuses a missing variable, legibly.
    expect(withoutEmployer("FedEx Express France", fedex)).toEqual({
      jobTitle: null,
      employerRemoved: true,
    });
  });

  it("falls back to the account name when there is no domain", () => {
    expect(
      withoutEmployer("Directeur des opérations chez Colis Privé", {
        name: "Colis Privé",
        domain: null,
      }),
    ).toEqual({ jobTitle: "Directeur des opérations", employerRemoved: true });
  });
});
