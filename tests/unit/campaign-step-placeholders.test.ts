import { describe, expect, it } from "vitest";

import { CAMPAIGN_STEP_PLACEHOLDERS } from "@/modules/campaigns/step-placeholders";
import {
  interpolateStrict,
  reasoningVariablesUsed,
} from "@/modules/messages/interpolation";

/**
 * The suggested copy the campaign form shows, held to the three rules the
 * shipped defaults broke.
 *
 * These were `defaultValue`s until a real run published them unedited: two
 * identical follow-ups three days apart, and a first email reading "I am
 * speaking with Directeur Général de l'Experience Client Chez FedEx Express
 * France leaders at companies like FedEx Express France." They are placeholders
 * now — an empty box cannot be sent by accident — but the copy is still shown,
 * so it still has to be copy that works.
 */
describe("campaign step placeholders", () => {
  it("offers one for each of the three steps", () => {
    expect(CAMPAIGN_STEP_PLACEHOLDERS).toHaveLength(3);
  });

  it("never repeats a subject or a body across steps", () => {
    // The published live sequence had steps 2 and 3 byte-identical, so the
    // second follow-up was a verbatim copy of the first.
    const subjects = CAMPAIGN_STEP_PLACEHOLDERS.map((step) => step.subject);
    const bodies = CAMPAIGN_STEP_PLACEHOLDERS.map((step) => step.body);
    expect(new Set(subjects).size).toBe(subjects.length);
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it("never inlines the job title", () => {
    // `{{job_title}}` holds whatever the discovery agent reported — a business
    // card title at best, a LinkedIn headline carrying its own employer at
    // worst. Neither is a sentence fragment, so suggested copy must not put one
    // mid-sentence. It stays a legal variable; it just stops being suggested.
    for (const step of CAMPAIGN_STEP_PLACEHOLDERS) {
      expect(`${step.subject} ${step.body}`).not.toContain("{{job_title}}");
    }
  });

  it("interpolates cleanly for a prospect with every deterministic field", () => {
    for (const step of CAMPAIGN_STEP_PLACEHOLDERS) {
      for (const template of [step.subject, step.body]) {
        expect(
          interpolateStrict(template, {
            first_name: "Nora",
            last_name: "Blanc",
            company: "Mondial Relay",
            job_title: "Directrice des opérations",
          }),
        ).toEqual(expect.any(String));
      }
    }
  });

  it("asks for no agent-written field", () => {
    // The AI checkboxes ship unchecked, and a template naming an undeclared
    // reasoning variable is refused outright by the campaign configuration
    // schema. Suggested copy an operator pastes must not be copy that cannot
    // be published.
    for (const step of CAMPAIGN_STEP_PLACEHOLDERS) {
      expect(reasoningVariablesUsed(step.subject, step.body)).toEqual([]);
    }
  });
});
