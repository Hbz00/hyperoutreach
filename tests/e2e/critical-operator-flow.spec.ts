import { expect, request as playwrightRequest, test } from "@playwright/test";

import {
  E2E_OPERATOR_EMAIL,
  E2E_OPERATOR_PASSWORD,
} from "./support/environment";

function hidden(html: string, name: string): string {
  const pattern = new RegExp(`name=["']${name}["'][^>]*value=["']([^"']+)["']`);
  const match = html.match(pattern);
  if (!match?.[1]) throw new Error(`Missing hidden field ${name}`);
  return match[1].replaceAll("&amp;", "&");
}

function pathId(location: string | undefined, prefix: string): string {
  if (!location) throw new Error("Missing redirect location");
  const match = new URL(location, "http://127.0.0.1:3000").pathname.match(
    new RegExp(`^${prefix}/([0-9a-f-]+)$`, "i"),
  );
  if (!match?.[1]) throw new Error(`Unexpected redirect ${location}`);
  return match[1];
}

function optionValue(html: string, selectName: string): string {
  const select = html.match(
    new RegExp(`name=["']${selectName}["'][^>]*>([\\s\\S]*?)</select>`),
  )?.[1];
  const values = [
    ...(select ?? "").matchAll(/<option[^>]*value=["']([^"']+)["']/g),
  ]
    .map((match) => match[1])
    .filter(Boolean);
  if (!values[0]) throw new Error(`Missing option for ${selectName}`);
  return values[0];
}

function hiddenNear(html: string, marker: string, name: string): string {
  const chunk = html
    .split('class="review-card"')
    .find((candidate) => candidate.includes(marker));
  if (!chunk) throw new Error(`Missing review card for ${marker}`);
  return hidden(chunk, name);
}

function enrollmentIdentity(html: string): string {
  const match = html.match(/data-enrollment-id="([0-9a-f-]+)"/i);
  if (!match?.[1]) throw new Error("Missing enrollment identity");
  return match[1];
}

test("operates the mock outreach lifecycle through authenticated application endpoints", async ({
  baseURL,
}) => {
  const browser = await playwrightRequest.newContext({
    baseURL,
  });
  await browser.post("/api/operator/session", {
    form: {
      intent: "login",
      email: E2E_OPERATOR_EMAIL,
      password: E2E_OPERATOR_PASSWORD,
      next: "/prospects",
    },
  });
  const prospects = await browser.get("/prospects");
  const csrf = hidden(await prospects.text(), "csrf");
  const initialSettings = await (await browser.get("/settings")).text();
  expect(initialSettings).toContain("Maintenance automation");
  expect(initialSettings).toContain("Not started");
  expect(initialSettings).toContain("Disabled by configuration");
  const settingsForm = new FormData();
  settingsForm.set("csrf", csrf);
  settingsForm.set("timezone", "UTC");
  for (const day of ["0", "1", "2", "3", "4", "5", "6"]) {
    settingsForm.append("workingDays", day);
  }
  settingsForm.set("workingStartMinute", "0");
  settingsForm.set("workingEndMinute", "1440");
  settingsForm.set("mailboxDailyCap", "10000");
  settingsForm.set("campaignDailyCap", "100000");
  settingsForm.set("mailboxMinimumDelaySeconds", "0");
  settingsForm.set("contactMinimumDelayMinutes", "0");
  settingsForm.set("crossCampaignCooldownDays", "0");
  await browser.post("/api/operator/commands/update-settings", {
    form: settingsForm,
  });
  const unique = crypto.randomUUID().slice(0, 8);
  const prospectForm = {
    csrf,
    companyName: `Critical Flow ${unique}`,
    domain: `critical-${unique}.example`,
    firstName: "Ada",
    lastName: "Lovelace",
    jobTitle: "Head of Product",
    email: `ada@critical-${unique}.example`,
  };
  const created = await browser.post("/api/operator/commands/create-prospect", {
    form: prospectForm,
    maxRedirects: 0,
  });
  expect(created.status()).toBe(303);
  const contactId = pathId(created.headers().location, "/prospects");

  const duplicate = await browser.post(
    "/api/operator/commands/create-prospect",
    { form: prospectForm, maxRedirects: 0 },
  );
  expect(pathId(duplicate.headers().location, "/prospects")).toBe(contactId);
  const accountRegistry = await (await browser.get("/prospects")).text();
  expect(accountRegistry).toContain("Account registry");
  expect(accountRegistry).toContain(`Critical Flow ${unique}`);
  expect(accountRegistry).toContain("Research account");
  expect(accountRegistry).toContain("Discover contacts");

  let prospectDetail = await (
    await browser.get(`/prospects/${contactId}`)
  ).text();
  const accountId = hidden(prospectDetail, "accountId");
  await browser.post("/api/operator/commands/research-account", {
    form: {
      csrf,
      accountId,
      force: "on",
      requestToken: crypto.randomUUID(),
      returnTo: `/prospects/${contactId}`,
    },
  });
  prospectDetail = await (await browser.get(`/prospects/${contactId}`)).text();
  expect(prospectDetail).toContain("Deterministic local research fixture");
  expect(prospectDetail).toContain(
    "https://example.invalid/hyperoutreach-mock-research",
  );

  const campaign = await browser.post(
    "/api/operator/commands/create-campaign",
    {
      form: {
        csrf,
        name: `Discovery ${unique}`,
        type: "customer_discovery",
        targetDescription:
          "Product leaders at evidence-backed software companies in Europe",
        step0DelayMinutes: "0",
        step0Subject: "A question for {{company}}",
        step0Body: "Hello {{first_name}}, would you be open to a short call?",
        step1DelayMinutes: "0",
        step1Subject: "Following up, {{first_name}}",
        step1Body: "Hello {{first_name}}, just following up on my note.",
        step2DelayMinutes: "0",
        step2Subject: "Closing the loop",
        step2Body: "Hello {{first_name}}, should I close the loop?",
      },
      maxRedirects: 0,
    },
  );
  expect(campaign.status()).toBe(303);
  const campaignId = pathId(campaign.headers().location, "/campaigns");
  const campaignPage = await browser.get(`/campaigns/${campaignId}`);
  const campaignHtml = await campaignPage.text();
  const versionId = hidden(campaignHtml, "campaignVersionId");

  expect(
    (
      await browser.post("/api/operator/commands/publish-campaign", {
        form: { csrf, campaignId, campaignVersionId: versionId },
        maxRedirects: 0,
      })
    ).status(),
  ).toBe(303);
  const mailboxId = optionValue(
    await (await browser.get(`/campaigns/${campaignId}`)).text(),
    "mailboxId",
  );
  expect(
    (
      await browser.post("/api/operator/commands/enroll-contact", {
        form: {
          csrf,
          campaignId,
          campaignVersionId: versionId,
          contactId,
          mailboxId,
        },
        maxRedirects: 0,
      })
    ).status(),
  ).toBe(303);

  const detail = await browser.get(`/prospects/${contactId}`);
  const enrollmentId = enrollmentIdentity(await detail.text());
  expect(
    (
      await browser.post("/api/operator/commands/generate-message", {
        form: { csrf, enrollmentId, stepIndex: "0" },
        maxRedirects: 0,
      })
    ).status(),
  ).toBe(303);

  let reviewHtml = await (await browser.get("/review")).text();
  expect(reviewHtml).toContain("A question for");
  let messageId = hiddenNear(
    reviewHtml,
    `Critical Flow ${unique}`,
    "messageId",
  );
  await browser.post("/api/operator/commands/review-message", {
    form: { csrf, messageId, reviewAction: "unexpected-action" },
  });
  reviewHtml = await (await browser.get("/review")).text();
  const unreviewedCard = reviewHtml
    .split('class="review-card"')
    .find((candidate) => candidate.includes(`Critical Flow ${unique}`));
  expect(unreviewedCard).toContain(">proposed<");
  await browser.post("/api/operator/commands/review-message", {
    form: { csrf, messageId, reviewAction: "approve" },
  });
  await browser.post("/api/operator/commands/send-message", {
    form: { csrf, messageId },
  });

  await browser.post("/api/operator/commands/reconcile-followups", {
    form: { csrf },
  });
  reviewHtml = await (await browser.get("/review")).text();
  expect(reviewHtml).toContain("Following up");
  messageId = hiddenNear(reviewHtml, `Critical Flow ${unique}`, "messageId");
  await browser.post("/api/operator/commands/review-message", {
    form: { csrf, messageId, reviewAction: "approve" },
  });
  await browser.post("/api/operator/commands/send-message", {
    form: { csrf, messageId },
  });

  await browser.post("/api/operator/commands/inject-reply", {
    form: {
      csrf,
      messageId,
      subject: "Re: Following up",
      body: "Please unsubscribe me from future messages.",
    },
  });
  const inbox = await (await browser.get("/inbox")).text();
  expect(inbox).toContain("unsubscribe");
  expect(inbox).toContain("Please unsubscribe me");
  const settings = await (await browser.get("/settings")).text();
  expect(settings).toContain(`ada@critical-${unique}.example`);
  const stoppedDetail = await (
    await browser.get(`/prospects/${contactId}`)
  ).text();
  expect(stoppedDetail).toContain("opted_out");

  await browser.post("/api/operator/commands/reconcile-followups", {
    form: { csrf },
  });
  await browser.post("/api/operator/commands/generate-message", {
    form: { csrf, enrollmentId, stepIndex: "2" },
  });
  const afterTerminalReconcile = await (await browser.get("/review")).text();
  const terminalCards = afterTerminalReconcile
    .split('class="review-card"')
    .filter((candidate) => candidate.includes(`Critical Flow ${unique}`));
  expect(
    terminalCards.every((card) => !card.includes("Closing the loop")),
  ).toBe(true);

  const suppressionProbe = await browser.post(
    "/api/operator/commands/create-campaign",
    {
      form: {
        csrf,
        name: `Suppression Probe ${unique}`,
        type: "customer_discovery",
        targetDescription: "Verify global suppression on a later campaign",
        step0DelayMinutes: "0",
        step0Subject: "Suppression policy check",
        step0Body: "Hello {{first_name}}, this must never be delivered.",
      },
      maxRedirects: 0,
    },
  );
  const probeCampaignId = pathId(
    suppressionProbe.headers().location,
    "/campaigns",
  );
  let probePage = await (
    await browser.get(`/campaigns/${probeCampaignId}`)
  ).text();
  const probeVersionId = hidden(probePage, "campaignVersionId");
  await browser.post("/api/operator/commands/publish-campaign", {
    form: {
      csrf,
      campaignId: probeCampaignId,
      campaignVersionId: probeVersionId,
    },
  });
  probePage = await (await browser.get(`/campaigns/${probeCampaignId}`)).text();
  await browser.post("/api/operator/commands/enroll-contact", {
    form: {
      csrf,
      campaignId: probeCampaignId,
      campaignVersionId: probeVersionId,
      contactId,
      mailboxId: optionValue(probePage, "mailboxId"),
    },
  });
  const probeEnrollmentId = enrollmentIdentity(
    await (await browser.get(`/prospects/${contactId}`)).text(),
  );
  await browser.post("/api/operator/commands/generate-message", {
    form: { csrf, enrollmentId: probeEnrollmentId, stepIndex: "0" },
  });
  const probeReview = await (await browser.get("/review")).text();
  const probeMessageId = hiddenNear(
    probeReview,
    `Suppression Probe ${unique}`,
    "messageId",
  );
  await browser.post("/api/operator/commands/review-message", {
    form: { csrf, messageId: probeMessageId, reviewAction: "approve" },
  });
  await browser.post("/api/operator/commands/send-message", {
    form: { csrf, messageId: probeMessageId },
  });
  const blockedSettings = await (await browser.get("/settings")).text();
  const probeAudit = blockedSettings
    .split('class="audit-row"')
    .find((candidate) => candidate.includes(probeMessageId));
  expect(probeAudit).toContain("RECIPIENT_SUPPRESSED");

  await browser.dispose();
});
