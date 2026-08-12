import { expect, type Locator, test } from "@playwright/test";

test.skip(
  process.env.RUN_BROWSER_E2E !== "1",
  "Set RUN_BROWSER_E2E=1 on a host where Chromium is permitted",
);

async function createCampaign(
  page: import("@playwright/test").Page,
  input: {
    name: string;
    target: string;
    firstSubject: string;
    firstBody: string;
    followUpSubject?: string;
    followUpBody?: string;
    finalSubject?: string;
    finalBody?: string;
  },
) {
  await page.getByRole("link", { name: "Campaigns", exact: true }).click();
  const form = page
    .locator('form[action$="create-campaign"]')
    .filter({ has: page.getByLabel("Name") });
  await form.getByLabel("Name").fill(input.name);
  await form.getByLabel("Precise ICP").fill(input.target);
  await form.getByLabel("Campaign daily cap").fill("100");
  await form.getByLabel("Delay in minutes").nth(0).fill("0");
  await form.getByLabel("Subject").nth(0).fill(input.firstSubject);
  await form.getByLabel("Body").nth(0).fill(input.firstBody);
  await form.getByLabel("Delay in minutes").nth(1).fill("0");
  await form
    .getByLabel("Subject")
    .nth(1)
    .fill(input.followUpSubject ?? "");
  await form
    .getByLabel("Body")
    .nth(1)
    .fill(input.followUpBody ?? "");
  await form
    .getByLabel("Subject")
    .nth(2)
    .fill(input.finalSubject ?? "");
  await form
    .getByLabel("Body")
    .nth(2)
    .fill(input.finalBody ?? "");
  await form.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("heading", { name: input.name })).toBeVisible();
  await page.getByRole("button", { name: /Publish version/ }).click();
  await expect(page.getByRole("status")).toContainText(
    "Campaign version published",
  );
}

async function enrollCurrentProspect(
  page: import("@playwright/test").Page,
  prospectLabel: string,
) {
  const form = page.locator('form[action$="enroll-contact"]');
  await form.getByLabel("Prospect").selectOption({ label: prospectLabel });
  await form.getByLabel("Mailbox").selectOption({ index: 1 });
  await form.getByRole("button", { name: "Enroll contact" }).click();
  await expect(page.getByRole("status")).toContainText("Contact enrolled");
}

function messageCard(page: import("@playwright/test").Page, marker: string) {
  return page.locator("article.review-card").filter({ hasText: marker });
}

async function approveAndSend(card: Locator) {
  await expect(card.getByText("Current", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card.getByText("approved", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Send approved message" }).click();
}

test("operates the complete rendered outreach lifecycle and blocks a suppressed recipient", async ({
  page,
}) => {
  const unique = crypto.randomUUID().slice(0, 8);
  const company = `Browser Flow ${unique}`;
  const domain = `browser-${unique}.example`;
  const email = `grace@${domain}`;
  const prospectOption = `Grace Hopper · ${email}`;
  const campaign = `Discovery ${unique}`;
  const firstSubject = `Evidence conversation ${unique}`;
  const followUpSubject = `Evidence follow-up ${unique}`;
  const finalSubject = `Evidence final follow-up ${unique}`;
  const suppressionCampaign = `Suppression probe ${unique}`;
  const suppressionSubject = `Suppression policy ${unique}`;

  await test.step("sign in and configure deterministic local sending policy", async () => {
    await page.goto("/login");
    await page.getByLabel("Operator email").fill("operator@example.com");
    await page.getByLabel("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("heading", { name: "Campaign state at a glance" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const settings = page.locator('form[action$="update-settings"]');
    for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      await settings.getByLabel(day, { exact: true }).check();
    }
    await settings.getByLabel("Start minute").fill("0");
    await settings.getByLabel("End minute").fill("1440");
    await settings.getByLabel("Mailbox minimum delay (seconds)").fill("0");
    await settings.getByLabel("Contact minimum delay (minutes)").fill("0");
    await settings.getByLabel("Cross-campaign cooldown (days)").fill("0");
    await settings.getByRole("button", { name: "Save sending policy" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Sending policy updated",
    );
  });

  await test.step("create a prospect and prove the rendered deduplication path", async () => {
    await page.getByRole("link", { name: "Prospects", exact: true }).click();
    const form = page.locator('form[action$="create-prospect"]');
    await form.getByLabel("Company").fill(company);
    await form.getByLabel("Domain").fill(domain);
    await form.getByLabel("First name").fill("Grace");
    await form.getByLabel("Last name").fill("Hopper");
    await form.getByLabel("Job title").fill("Engineering leader");
    await form.getByLabel("Email").fill(email);
    await form.getByRole("button", { name: "Save prospect" }).click();
    await expect(
      page.getByRole("heading", { name: "Grace Hopper" }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Prospect created");

    await page.getByRole("link", { name: "Back to prospects" }).click();
    await form.getByLabel("Company").fill(company);
    await form.getByLabel("Domain").fill(domain);
    await form.getByLabel("First name").fill("Grace");
    await form.getByLabel("Last name").fill("Hopper");
    await form.getByLabel("Job title").fill("Engineering leader");
    await form.getByLabel("Email").fill(email);
    await form.getByRole("button", { name: "Save prospect" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Existing prospect reused",
    );
    await page.getByRole("link", { name: "Back to prospects" }).click();
    await expect(page.getByRole("link", { name: "Grace Hopper" })).toHaveCount(
      1,
    );
  });

  await test.step("produce reusable account research and inspect its evidence", async () => {
    const accountRow = page
      .locator("tbody tr")
      .filter({ hasText: company })
      .first();
    await accountRow.getByRole("button", { name: "Research account" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Account research executed",
    );
    await page.getByRole("link", { name: "Grace Hopper" }).click();
    await expect(
      page.getByText("Deterministic local research fixture"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Deterministic local fixture" }),
    ).toHaveAttribute(
      "href",
      "https://example.invalid/hyperoutreach-mock-research",
    );
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.getByText("accepted", { exact: true })).toBeVisible();
  });

  await test.step("publish a sequence, enroll, generate, inspect, approve, and mock-send", async () => {
    await createCampaign(page, {
      name: campaign,
      target:
        "Product and engineering leaders at evidence-backed European software companies",
      firstSubject,
      firstBody:
        "Hello {{first_name}}, would you be open to a short customer-discovery call?",
      followUpSubject,
      followUpBody: "Hello {{first_name}}, following up on my earlier note.",
      finalSubject,
      finalBody: "Hello {{first_name}}, one last customer-discovery follow-up.",
    });
    await enrollCurrentProspect(page, prospectOption);

    await page.getByRole("link", { name: "Prospects", exact: true }).click();
    await page.getByRole("link", { name: "Grace Hopper" }).click();
    const enrollment = page
      .locator("article.timeline-card")
      .filter({ hasText: campaign });
    await enrollment.getByRole("button", { name: "Generate step 1" }).click();
    const card = messageCard(page, campaign);
    await expect(card.getByLabel("Subject")).toHaveValue(firstSubject);
    await expect(card.getByLabel("Body")).toContainText("Hello Grace");
    await expect(
      card.getByText(/100% \(operator_manual, accepted\)/),
    ).toBeVisible();
    await expect(card.getByText("Deterministic local fixture")).toBeVisible();
    await approveAndSend(card);
    await expect(page.getByRole("status")).toContainText(
      "Send execution completed",
    );
    await expect(messageCard(page, campaign)).toHaveCount(0);
  });

  await test.step("process and send the due follow-up through the UI", async () => {
    await page.getByRole("button", { name: "Process due follow-ups" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Due follow-ups reconciled",
    );
    const card = messageCard(page, campaign);
    await expect(card.getByLabel("Subject")).toHaveValue(followUpSubject);
    await approveAndSend(card);
    await expect(messageCard(page, campaign)).toHaveCount(0);
  });

  await test.step("ingest an unsubscribe reply, classify it, and stop the sequence", async () => {
    await page.getByRole("link", { name: "Inbox", exact: true }).click();
    const replyForm = page.locator('form[action$="inject-reply"]');
    await replyForm
      .getByLabel("Outbound message")
      .selectOption({ label: `Grace Hopper · ${followUpSubject}` });
    await replyForm.getByLabel("Subject").fill(`Re: ${followUpSubject}`);
    await replyForm
      .getByLabel("Body")
      .fill("Please unsubscribe me from every future message.");
    await replyForm.getByRole("button", { name: "Ingest reply" }).click();
    await expect(page.getByRole("status")).toContainText("Reply ingested");
    const reply = page.locator("article.reply-card").first();
    await expect(reply.getByText("unsubscribe", { exact: true })).toBeVisible();
    await expect(reply.getByText("Yes", { exact: true })).toBeVisible();
    await expect(reply.getByText("opted_out", { exact: true })).toBeVisible();
    await expect(reply.getByText("unsubscribe", { exact: true })).toHaveCount(
      2,
    );

    await page.getByRole("link", { name: "Prospects", exact: true }).click();
    await page.getByRole("link", { name: "Grace Hopper" }).click();
    const stopped = page
      .locator("article.timeline-card")
      .filter({ hasText: campaign });
    await expect(stopped.getByText("opted_out", { exact: true })).toBeVisible();
    await expect(stopped).toContainText("next none");
    await expect(stopped.getByText(/stop unsubscribe/)).toBeVisible();
    await expect(
      stopped.getByRole("button", { name: /Generate step/ }),
    ).toHaveCount(0);
  });

  await test.step("show persistent suppression and block a later campaign send", async () => {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const suppressionRow = page.locator("tbody tr").filter({ hasText: email });
    await expect(suppressionRow).toContainText("unsubscribe");

    await createCampaign(page, {
      name: suppressionCampaign,
      target:
        "Verify that a globally suppressed recipient cannot be sent another campaign",
      firstSubject: suppressionSubject,
      firstBody: "Hello {{first_name}}, this message must be blocked.",
    });
    await enrollCurrentProspect(page, prospectOption);
    await page.getByRole("link", { name: "Prospects", exact: true }).click();
    await page.getByRole("link", { name: "Grace Hopper" }).first().click();
    const probeEnrollment = page
      .locator("article.timeline-card")
      .filter({ hasText: suppressionCampaign });
    await probeEnrollment
      .getByRole("button", { name: "Generate step 1" })
      .click();
    const probeCard = messageCard(page, suppressionCampaign);
    await expect(probeCard.getByLabel("Subject")).toHaveValue(
      suppressionSubject,
    );
    await probeCard
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await probeCard
      .getByRole("button", { name: "Send approved message" })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Send execution completed",
    );
    await expect(
      probeCard.getByText("approved", { exact: true }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const audit = page
      .locator("details.audit-row")
      .filter({ hasText: "send-approved-message" })
      .first();
    await audit.locator("summary").click();
    await expect(audit).toContainText("RECIPIENT_SUPPRESSED");
    await expect(
      page.locator("tbody tr").filter({ hasText: email }),
    ).toContainText("unsubscribe");
  });
});
