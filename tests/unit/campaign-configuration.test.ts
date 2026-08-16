import { describe, expect, it } from "vitest";

import {
  campaignConfigurationSchema,
  createCampaignSchema,
} from "@/modules/campaigns/input";

describe("campaign configuration", () => {
  it("accepts the settings the product actually honours", () => {
    expect(
      campaignConfigurationSchema.safeParse({
        automaticFollowUps: true,
        holdNonTerminalReplies: true,
        requireProfessionalRelevance: false,
        campaignDailyCap: 25,
      }).success,
    ).toBe(true);
  });

  // `reviewMode` was stored, rendered in a one-option picker, and read by no
  // decision logic — while the API happily accepted `assisted` and
  // `automatic` and wrote them into a version that can never be edited. The
  // catchall means simply deleting the key would make the schema *accept* it
  // silently, which is the same lie in a quieter voice.
  it("rejects reviewMode rather than silently accepting it through the catchall", () => {
    const result = campaignConfigurationSchema.safeParse({
      reviewMode: "automatic",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("reviewMode");
  });

  it("rejects reviewMode even when it carries the only value that ever worked", () => {
    expect(
      campaignConfigurationSchema.safeParse({ reviewMode: "manual" }).success,
    ).toBe(false);
  });

  it("still accepts unknown forward-compatible keys", () => {
    expect(
      campaignConfigurationSchema.safeParse({ somethingNewer: 1 }).success,
    ).toBe(true);
  });
});

describe("a step that asks the agent for a sentence", () => {
  const step = (overrides: Record<string, unknown> = {}) => ({
    delayMinutes: 0,
    subjectTemplate: "Hello {{first_name}}",
    bodyTemplate: "A note for {{company}}",
    ...overrides,
  });
  const parse = (value: Record<string, unknown>) =>
    createCampaignSchema.safeParse({
      name: "Campaign",
      type: "commercial_outreach",
      targetDescription: "Leaders at relevant companies",
      configuration: {},
      steps: [value],
    });

  it("accepts a step that declares nothing and uses nothing", () => {
    expect(parse(step()).success).toBe(true);
  });

  it("accepts a declaration the template actually uses", () => {
    expect(
      parse(
        step({
          bodyTemplate: "{{personalized_opening}} — about {{company}}",
          personalizationSchema: { fields: ["personalized_opening"] },
        }),
      ).success,
    ).toBe(true);
  });

  // The agent would be called, a turn spent on the operator's subscription,
  // the sentence persisted and announced in review — and it would appear
  // nowhere in the email. The campaign version is immutable, so this is not
  // repairable for enrollments already on it.
  it("refuses to pay for a sentence the template never uses", () => {
    const result = parse(
      step({ personalizationSchema: { fields: ["personalized_opening"] } }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "personalized_opening",
    );
  });

  it("refuses a template variable the agent was never asked to write", () => {
    expect(
      parse(step({ bodyTemplate: "{{company_relevance}} matters" })).success,
    ).toBe(false);
  });

  it("refuses a partial match between what is declared and what is used", () => {
    expect(
      parse(
        step({
          bodyTemplate: "{{personalized_opening}} and more",
          personalizationSchema: {
            fields: ["personalized_opening", "company_relevance"],
          },
        }),
      ).success,
    ).toBe(false);
  });

  // Only the first step is generated through the operator-command queue, the
  // one path wired to the personalizing generator. Every later step is written
  // by `processFollowUpInvocation`, which calls the deterministic generator —
  // so a declaration there reaches interpolation with no such value and fails
  // on MISSING_VARIABLE, one prospect at a time, against an immutable version.
  it("refuses a follow-up step that asks the agent for a sentence", () => {
    const result = createCampaignSchema.safeParse({
      name: "Campaign",
      type: "commercial_outreach",
      targetDescription: "Leaders at relevant companies",
      configuration: {},
      steps: [
        step(),
        step({
          delayMinutes: 4_320,
          bodyTemplate: "{{personalized_opening}} — following up",
          personalizationSchema: { fields: ["personalized_opening"] },
        }),
      ],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "Only the first step",
    );
  });

  it("still accepts an AI sentence on the first step of a multi-step sequence", () => {
    expect(
      createCampaignSchema.safeParse({
        name: "Campaign",
        type: "commercial_outreach",
        targetDescription: "Leaders at relevant companies",
        configuration: {},
        steps: [
          step({
            bodyTemplate: "{{personalized_opening}} — about {{company}}",
            personalizationSchema: { fields: ["personalized_opening"] },
          }),
          step({ delayMinutes: 4_320 }),
        ],
      }).success,
    ).toBe(true);
  });
});

describe("what a refused campaign tells the operator", () => {
  it("names the rule that was broken, not just that something was", async () => {
    const { createDraftCampaign } = await import("@/modules/campaigns/service");
    const result = await createDraftCampaign(null as never, {
      name: "Campaign",
      type: "commercial_outreach",
      targetDescription: "Leaders at relevant companies",
      configuration: {},
      steps: [
        {
          delayMinutes: 0,
          subjectTemplate: "Hello {{first_name}}",
          bodyTemplate: "A note for {{company}}",
          personalizationSchema: { fields: ["personalized_opening"] },
        },
      ],
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    if (result.ok) return;
    // A campaign version is immutable, so this refusal is the last cheap
    // moment to fix the mistake — it has to say what the mistake is.
    expect(result.message).toContain("personalized_opening");
  });
});
