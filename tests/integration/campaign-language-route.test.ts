import { chromium, type Browser, type Page } from "@playwright/test";
import { desc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { campaignVersions } from "@/lib/db/schema";

vi.mock("server-only", () => ({}));
const browserSession = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "hyperoutreach_session"
        ? { value: browserSession.token }
        : undefined,
  }),
}));

const { testUrl } = resolveDatabaseUrls(process.env);
const previousEnvironment = { ...process.env };
process.env.DATABASE_URL = testUrl;
process.env.OPERATOR_EMAIL = "campaign-language@example.test";
process.env.OPERATOR_PASSWORD = "synthetic-language-test-password";
process.env.SESSION_SECRET =
  "synthetic-language-session-secret-at-least-32-chars";
process.env.LOCAL_MAINTENANCE_ENABLED = "false";

const { getDatabase } = await import("@/lib/db/client");
const { createOperatorSession, OPERATOR_SESSION_COOKIE } =
  await import("@/lib/operator-auth");
const { createDraftCampaign, publishCampaignVersion } =
  await import("@/modules/campaigns/service");
const { default: CampaignDetailPage } =
  await import("@/app/(operator)/campaigns/[campaignId]/page");
const { POST } = await import("@/app/api/operator/commands/[command]/route");
const db = getDatabase();
let browser: Browser | undefined;
let page: Page | undefined;

beforeAll(async () => {
  await db.$client.unsafe("drop schema if exists public cascade");
  await db.$client.unsafe("drop schema if exists drizzle cascade");
  await db.$client.unsafe("create schema public");
  await migrate(db, { migrationsFolder: "drizzle" });
  browser = await chromium.launch({ headless: true });
});
beforeEach(async () => {
  browserSession.token = createOperatorSession().token;
  page = await browser!.newPage();
  page.setDefaultTimeout(5_000);
  // The DOM is supplied by the real server component. No server or external
  // navigation is needed to exercise native successful form controls.
  await page.route("**/*", (route) => route.abort());
});
afterEach(async () => {
  await page?.close();
  page = undefined;
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      await db.$client.end({ timeout: 5 });
    } finally {
      for (const key of [
        "DATABASE_URL",
        "OPERATOR_EMAIL",
        "OPERATOR_PASSWORD",
        "SESSION_SECRET",
        "LOCAL_MAINTENANCE_ENABLED",
      ]) {
        const prior = previousEnvironment[key];
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
      }
    }
  }
});

async function fixture(published: boolean, language?: string) {
  const created = await createDraftCampaign(db, {
    name: `Language ${crypto.randomUUID()}`,
    type: "customer_discovery",
    targetDescription: "Synthetic language-preservation campaign",
    configuration: {
      language,
      campaignDailyCap: 50,
      holdNonTerminalReplies: true,
    },
    steps: [
      {
        delayMinutes: 0,
        subjectTemplate: "Bonjour",
        bodyTemplate: "Bonjour {{first_name}}",
      },
    ],
  });
  if (!created.ok) throw new Error(created.code);
  if (published) {
    const result = await publishCampaignVersion(db, {
      campaignId: created.campaign.id,
      campaignVersionId: created.version.id,
    });
    if (!result.ok) throw new Error(result.code);
  }
  await page!.setContent(
    renderToStaticMarkup(
      await CampaignDetailPage({
        params: Promise.resolve({ campaignId: created.campaign.id }),
        searchParams: Promise.resolve({}),
      }),
    ),
  );
  if (published) {
    await page!
      .locator('details:has(form[action$="revise-campaign"]) > summary')
      .click();
  }
  return created;
}

async function submitRenderedForm(campaignId: string) {
  const entries = await page!
    .locator('form[action$="revise-campaign"]')
    .evaluate((element) =>
      [...new FormData(element as HTMLFormElement).entries()].map(
        ([key, value]) => [key, String(value)] as const,
      ),
    );
  const body = new FormData();
  for (const [key, value] of entries) body.append(key, value);
  const response = await POST(
    new Request("http://operator.local/api/operator/commands/revise-campaign", {
      method: "POST",
      body,
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${browserSession.token}` },
    }),
    { params: Promise.resolve({ command: "revise-campaign" }) },
  );
  expect(response.status).toBe(303);
  expect(
    new URL(
      response.headers.get("location")!,
      "http://operator.local",
    ).searchParams.get("notice"),
  ).toBe("Campaign version saved");
  return db
    .select()
    .from(campaignVersions)
    .where(eq(campaignVersions.campaignId, campaignId))
    .orderBy(desc(campaignVersions.version));
}

function languageOf(version: { configuration: unknown } | undefined) {
  expect(version).toBeDefined();
  return (version!.configuration as { language?: string }).language;
}

describe.each([false, true])(
  "rendered campaign language with published=%s",
  (published) => {
    it("preserves French through a native form submission and real persistence", async () => {
      const created = await fixture(published, "fr");
      const versions = await submitRenderedForm(created.campaign.id);
      expect(versions).toHaveLength(published ? 2 : 1);
      expect(languageOf(versions[0])).toBe("fr");
      expect(versions[0]?.publishedAt).toBeNull();
      if (published) {
        expect(versions[1]?.id).toBe(created.version.id);
        expect(versions[1]?.publishedAt).toBeInstanceOf(Date);
        expect(languageOf(versions[1])).toBe("fr");
      }
    });

    it("persists an explicit language edit while a published base stays immutable", async () => {
      const created = await fixture(published, "fr");
      const control = page!.locator(
        'form[action$="revise-campaign"] input[name="language"]',
      );
      expect(await control.count()).toBe(1);
      expect(await control.inputValue()).toBe("fr");
      await control.fill("de");
      const versions = await submitRenderedForm(created.campaign.id);
      expect(languageOf(versions[0])).toBe("de");
      if (published) expect(languageOf(versions[1])).toBe("fr");
    });

    it("keeps a legacy campaign with no language valid and does not invent one", async () => {
      const created = await fixture(published);
      const control = page!.locator(
        'form[action$="revise-campaign"] input[name="language"]',
      );
      expect(await control.count()).toBe(1);
      expect(await control.inputValue()).toBe("");
      expect(
        await control.evaluate((input) =>
          (input as HTMLInputElement).checkValidity(),
        ),
      ).toBe(true);
      const versions = await submitRenderedForm(created.campaign.id);
      expect(languageOf(versions[0])).toBeUndefined();
      if (published) expect(languageOf(versions[1])).toBeUndefined();
    });
  },
);
