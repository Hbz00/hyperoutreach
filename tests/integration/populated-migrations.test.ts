import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { resolveDatabaseUrls } from "@/lib/db/test-database";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 1 });

async function resetDatabase(): Promise<void> {
  await client.unsafe("drop schema if exists public cascade");
  await client.unsafe("drop schema if exists drizzle cascade");
  await client.unsafe("create schema public");
}

async function applyMigration(filename: string): Promise<void> {
  const migration = await readFile(`drizzle/${filename}`, "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

describe("populated migration upgrades", () => {
  beforeEach(resetDatabase);

  afterAll(async () => {
    await client.end();
  });

  it("adds email resolution state to populated contacts without losing data", async () => {
    for (const migration of [
      "0000_sturdy_kid_colt.sql",
      "0001_pink_luminals.sql",
      "0002_exotic_wind_dancer.sql",
      "0003_woozy_fenris.sql",
      "0004_brief_firedrake.sql",
      "0005_rainy_warbound.sql",
      "0006_sleepy_blade.sql",
      "0007_quiet_scrambler.sql",
      "0008_material_gunslinger.sql",
      "0009_parallel_venom.sql",
      "0010_fancy_quasimodo.sql",
    ]) {
      await applyMigration(migration);
    }
    const [{ accountId }] = await client<[{ accountId: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Populated Resolution', 'populated resolution', 'populated-resolution.example')
      returning id as "accountId"
    `;
    const [{ contactId }] = await client<[{ contactId: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name,
        job_title
      ) values (
        ${accountId}, 'Existing', 'Contact', 'Existing Contact',
        'existing contact', 'VP Sales'
      ) returning id as "contactId"
    `;

    await applyMigration("0011_sweet_misty_knight.sql");
    await applyMigration("0012_futuristic_meltdown.sql");
    await applyMigration("0013_powerful_viper.sql");
    await applyMigration("0014_futuristic_jean_grey.sql");
    await applyMigration("0015_spooky_the_fallen.sql");
    await applyMigration("0016_first_sersi.sql");
    await applyMigration("0017_wonderful_nekra.sql");
    await applyMigration("0018_colorful_arclight.sql");

    const [upgraded] = await client<
      [
        {
          id: string;
          jobTitle: string;
          resolutionStatus: string;
          attemptedAt: string | null;
          error: string | null;
          resolutionReason: string | null;
          researchClaimId: string | null;
          researchClaimedAt: string | null;
          employmentVersion: number;
        },
      ]
    >`
      select id, job_title as "jobTitle",
        email_resolution_status as "resolutionStatus",
        email_resolution_attempted_at as "attemptedAt",
        email_resolution_error as "error",
        email_resolution_reason as "resolutionReason",
        employment_version as "employmentVersion",
        (select research_claim_id from accounts where id = ${accountId}) as "researchClaimId",
        (select research_claimed_at from accounts where id = ${accountId}) as "researchClaimedAt"
      from contacts where id = ${contactId}
    `;
    expect(upgraded).toEqual({
      id: contactId,
      jobTitle: "VP Sales",
      resolutionStatus: "unresolved",
      attemptedAt: null,
      error: null,
      resolutionReason: null,
      researchClaimId: null,
      researchClaimedAt: null,
      employmentVersion: 1,
    });
  });

  it("deduplicates accepted email candidates before adding the one-accepted invariant", async () => {
    for (const migration of [
      "0000_sturdy_kid_colt.sql",
      "0001_pink_luminals.sql",
      "0002_exotic_wind_dancer.sql",
      "0003_woozy_fenris.sql",
      "0004_brief_firedrake.sql",
      "0005_rainy_warbound.sql",
      "0006_sleepy_blade.sql",
      "0007_quiet_scrambler.sql",
      "0008_material_gunslinger.sql",
      "0009_parallel_venom.sql",
      "0010_fancy_quasimodo.sql",
      "0011_sweet_misty_knight.sql",
      "0012_futuristic_meltdown.sql",
      "0013_powerful_viper.sql",
      "0014_futuristic_jean_grey.sql",
      "0015_spooky_the_fallen.sql",
    ]) {
      await applyMigration(migration);
    }
    const [{ accountId }] = await client<[{ accountId: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Accepted Upgrade', 'accepted upgrade', 'accepted-upgrade.example')
      returning id as "accountId"
    `;
    const [{ contactId }] = await client<[{ contactId: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Accepted', 'Upgrade', 'Accepted Upgrade', 'accepted upgrade')
      returning id as "contactId"
    `;
    await client`
      insert into email_candidates (
        contact_id, email, normalized_email, domain, confidence, source,
        status, verified_at
      ) values
        (${contactId}, 'lower@accepted-upgrade.example',
          'lower@accepted-upgrade.example', 'accepted-upgrade.example', 0.8,
          'legacy', 'accepted', '2026-01-01'),
        (${contactId}, 'winner@accepted-upgrade.example',
          'winner@accepted-upgrade.example', 'accepted-upgrade.example', 0.95,
          'legacy', 'accepted', '2026-01-02')
    `;

    await applyMigration("0016_first_sersi.sql");
    const candidates = await client<Array<{ email: string; status: string }>>`
      select normalized_email as email, status
      from email_candidates where contact_id = ${contactId}
      order by normalized_email
    `;
    expect(candidates).toEqual([
      { email: "lower@accepted-upgrade.example", status: "candidate" },
      { email: "winner@accepted-upgrade.example", status: "accepted" },
    ]);
  });

  it("cleans legacy dual-owner evidence before enforcing exactly one owner", async () => {
    await applyMigration("0000_sturdy_kid_colt.sql");
    await applyMigration("0001_pink_luminals.sql");
    const [{ accountId }] = await client<[{ accountId: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Legacy Evidence', 'legacy evidence', 'legacy-evidence.example')
      returning id as "accountId"
    `;
    const [{ contactId }] = await client<[{ contactId: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (
        ${accountId}, 'Legacy', 'Owner', 'Legacy Owner', 'legacy owner'
      ) returning id as "contactId"
    `;
    await client`
      insert into evidence_sources (
        account_id, contact_id, url, source_type, created_at
      ) values
        (
          ${accountId}, ${contactId}, 'https://legacy.example/evidence',
          'legacy', '2026-01-01'
        ),
        (
          null, ${contactId}, 'https://legacy.example/evidence',
          'legacy', '2026-01-02'
        )
    `;

    await applyMigration("0002_exotic_wind_dancer.sql");

    const evidence = await client<
      Array<{ accountId: string | null; contactId: string; url: string }>
    >`
      select account_id as "accountId", contact_id as "contactId", url
      from evidence_sources
    `;
    expect(evidence).toEqual([
      {
        accountId: null,
        contactId,
        url: "https://legacy.example/evidence",
      },
    ]);
  });

  it("retains the oldest legacy account evidence row before the account URL index", async () => {
    await applyMigration("0000_sturdy_kid_colt.sql");
    await applyMigration("0001_pink_luminals.sql");
    const [{ accountId }] = await client<[{ accountId: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Legacy Account Evidence', 'legacy account evidence', 'account-evidence.example')
      returning id as "accountId"
    `;
    const inserted = await client<Array<{ id: string }>>`
      insert into evidence_sources (
        account_id, contact_id, url, source_type, created_at
      ) values
        (
          ${accountId}, null, 'https://legacy.example/account-evidence',
          'oldest', '2026-01-01'
        ),
        (
          ${accountId}, null, 'https://legacy.example/account-evidence',
          'newer', '2026-01-02'
        )
      returning id
    `;

    await applyMigration("0002_exotic_wind_dancer.sql");

    const evidence = await client<
      Array<{ id: string; accountId: string; sourceType: string }>
    >`
      select id, account_id as "accountId", source_type as "sourceType"
      from evidence_sources
      where account_id = ${accountId}
        and url = 'https://legacy.example/account-evidence'
    `;
    expect(evidence).toEqual([
      {
        id: inserted[0]?.id,
        accountId,
        sourceType: "oldest",
      },
    ]);
  });

  it("publishes only historically enrolled versions during the 0003 upgrade", async () => {
    await applyMigration("0000_sturdy_kid_colt.sql");
    await applyMigration("0001_pink_luminals.sql");
    await applyMigration("0002_exotic_wind_dancer.sql");
    const [{ accountId }] = await client<[{ accountId: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Legacy Versions', 'legacy versions', 'legacy-versions.example')
      returning id as "accountId"
    `;
    const [{ contactId }] = await client<[{ contactId: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Version', 'Owner', 'Version Owner', 'version owner')
      returning id as "contactId"
    `;
    const [{ campaignId }] = await client<[{ campaignId: string }]>`
      insert into campaigns (name, type, target_description)
      values ('Legacy Campaign', 'commercial_outreach', 'Relevant operators')
      returning id as "campaignId"
    `;
    const versions = await client<Array<{ id: string; version: number }>>`
      insert into campaign_versions (campaign_id, version, configuration)
      values (${campaignId}, 1, '{}'), (${campaignId}, 2, '{}')
      returning id, version
    `;
    const usedVersion = versions[0];
    if (!usedVersion) throw new Error("Expected a legacy campaign version");
    await client`
      insert into enrollments (campaign_id, campaign_version_id, contact_id)
      values (${campaignId}, ${usedVersion.id}, ${contactId})
    `;

    await applyMigration("0003_woozy_fenris.sql");

    const upgraded = await client<
      Array<{
        version: number;
        publishedAt: string | null;
        usedAt: string | null;
      }>
    >`
      select version, published_at as "publishedAt", used_at as "usedAt"
      from campaign_versions order by version
    `;
    expect(upgraded[0]?.usedAt).not.toBeNull();
    expect(upgraded[0]?.publishedAt).not.toBeNull();
    expect(upgraded[1]).toMatchObject({ usedAt: null, publishedAt: null });
  });

  it("repairs only the buggy 0003 unused-version backfill", async () => {
    await applyMigration("0000_sturdy_kid_colt.sql");
    await applyMigration("0001_pink_luminals.sql");
    await applyMigration("0002_exotic_wind_dancer.sql");
    await applyMigration("0003_woozy_fenris.sql");
    const [{ campaignId }] = await client<[{ campaignId: string }]>`
      insert into campaigns (name, type, target_description)
      values ('Repair Campaign', 'other', 'Internal migration verification')
      returning id as "campaignId"
    `;
    const versions = await client<Array<{ id: string; version: number }>>`
      insert into campaign_versions (campaign_id, version, configuration)
      values (${campaignId}, 1, '{}'), (${campaignId}, 2, '{}')
      returning id, version
    `;
    await client`
      update campaign_versions
      set published_at = case
        when version = 1 then created_at
        else created_at + interval '1 second'
      end
      where campaign_id = ${campaignId}
    `;

    await applyMigration("0004_brief_firedrake.sql");

    const repaired = await client<
      Array<{ version: number; publishedAt: string | null }>
    >`
      select version, published_at as "publishedAt"
      from campaign_versions where campaign_id = ${campaignId} order by version
    `;
    expect(repaired[0]).toEqual({ version: 1, publishedAt: null });
    expect(repaired[1]?.publishedAt).not.toBeNull();
    expect(versions).toHaveLength(2);
  });

  it("upgrades populated legacy replies and enrollments through 0005", async () => {
    for (const migration of [
      "0000_sturdy_kid_colt.sql",
      "0001_pink_luminals.sql",
      "0002_exotic_wind_dancer.sql",
      "0003_woozy_fenris.sql",
      "0004_brief_firedrake.sql",
    ]) {
      await applyMigration(migration);
    }
    const [{ accountId }] = await client<[{ accountId: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Legacy Reply', 'legacy reply', 'legacy-reply.example')
      returning id as "accountId"
    `;
    const [{ contactId }] = await client<[{ contactId: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Legacy', 'Reply', 'Legacy Reply', 'legacy reply')
      returning id as "contactId"
    `;
    const [{ campaignId }] = await client<[{ campaignId: string }]>`
      insert into campaigns (name, type, target_description, status)
      values ('Legacy Replies', 'other', 'Legacy migration validation', 'active')
      returning id as "campaignId"
    `;
    const [{ versionId }] = await client<[{ versionId: string }]>`
      insert into campaign_versions (campaign_id, version, configuration, published_at)
      values (${campaignId}, 1, '{}', now()) returning id as "versionId"
    `;
    const [{ mailboxId }] = await client<[{ mailboxId: string }]>`
      insert into mailbox_connections (
        provider, email, normalized_email, status
      ) values ('mock', 'legacy@example.com', 'legacy@example.com', 'available')
      returning id as "mailboxId"
    `;
    const [{ enrollmentId }] = await client<[{ enrollmentId: string }]>`
      insert into enrollments (
        campaign_id, campaign_version_id, contact_id, mailbox_id
      ) values (${campaignId}, ${versionId}, ${contactId}, ${mailboxId})
      returning id as "enrollmentId"
    `;
    const [{ messageId }] = await client<[{ messageId: string }]>`
      insert into messages (
        enrollment_id, step_index, direction, outreach_id, subject, body,
        recipient, status
      ) values (
        ${enrollmentId}, 0, 'outbound', 'legacy-outreach', 'Hello', 'Body',
        'legacy@legacy-reply.example', 'sent'
      ) returning id as "messageId"
    `;
    const [{ inboundId }] = await client<[{ inboundId: string }]>`
      insert into inbound_records (
        mailbox_id, provider_message_id, event_type, payload_hash, status
      ) values (${mailboxId}, 'legacy-inbound', 'message', 'legacy-hash', 'processed')
      returning id as "inboundId"
    `;
    await client`
      insert into replies (
        inbound_record_id, message_id, enrollment_id, body, classification,
        confidence, terminates_sequence, received_at
      ) values (
        ${inboundId}, ${messageId}, ${enrollmentId}, 'Legacy body', 'positive',
        0.9, true, now()
      )
    `;

    await applyMigration("0005_rainy_warbound.sql");

    const [{ count: settingsCount }] = await client<[{ count: number }]>`
      select count(*)::int as count from operator_sending_settings
    `;
    expect(settingsCount).toBe(1);

    const [reply] = await client<
      Array<{
        classificationReason: string;
        classifier: string;
        sender: string;
        subject: string;
      }>
    >`
      select
        classification_reason as "classificationReason",
        classifier,
        sender,
        subject
      from replies where inbound_record_id = ${inboundId}
    `;
    expect(reply).toEqual({
      classificationReason: "Legacy classification",
      classifier: "legacy",
      sender: "unknown@legacy.invalid",
      subject: "(legacy inbound)",
    });

    await client`delete from operator_sending_settings`;
    await applyMigration("0006_sleepy_blade.sql");
    await applyMigration("0007_quiet_scrambler.sql");
    await applyMigration("0008_material_gunslinger.sql");
    await applyMigration("0009_parallel_venom.sql");
    await applyMigration("0010_fancy_quasimodo.sql");
    const [repairedMessage] = await client<Array<{ mailboxId: string | null }>>`
      select mailbox_id as "mailboxId" from messages where id = ${messageId}
    `;
    expect(repairedMessage?.mailboxId).toBe(mailboxId);
    const [{ count: repairedSettingsCount }] = await client<
      [{ count: number }]
    >`
      select count(*)::int as count from operator_sending_settings
    `;
    expect(repairedSettingsCount).toBe(1);
    const [upgradedEnrollment] = await client<
      Array<{
        inboundHoldCount: number;
        workflowClaimId: string | null;
      }>
    >`
      select inbound_hold_count as "inboundHoldCount",
             workflow_claim_id as "workflowClaimId"
      from enrollments where id = ${enrollmentId}
    `;
    expect(upgradedEnrollment).toEqual({
      inboundHoldCount: 0,
      workflowClaimId: null,
    });
    const [upgradedInbound] = await client<
      Array<{
        classificationClaimId: string | null;
        classificationClaimedAt: string | null;
        lastAttemptAt: string | null;
      }>
    >`
      select classification_claim_id as "classificationClaimId",
             classification_claimed_at as "classificationClaimedAt",
             last_attempt_at as "lastAttemptAt"
      from inbound_records where id = ${inboundId}
    `;
    expect(upgradedInbound).toEqual({
      classificationClaimId: null,
      classificationClaimedAt: null,
      lastAttemptAt: null,
    });
  });

  it("adds the maintenance singleton to a populated database without losing workflow history", async () => {
    for (const migration of [
      "0000_sturdy_kid_colt.sql",
      "0001_pink_luminals.sql",
      "0002_exotic_wind_dancer.sql",
      "0003_woozy_fenris.sql",
      "0004_brief_firedrake.sql",
      "0005_rainy_warbound.sql",
      "0006_sleepy_blade.sql",
      "0007_quiet_scrambler.sql",
      "0008_material_gunslinger.sql",
      "0009_parallel_venom.sql",
      "0010_fancy_quasimodo.sql",
      "0011_sweet_misty_knight.sql",
      "0012_futuristic_meltdown.sql",
      "0013_powerful_viper.sql",
      "0014_futuristic_jean_grey.sql",
      "0015_spooky_the_fallen.sql",
      "0016_first_sersi.sql",
      "0017_wonderful_nekra.sql",
      "0018_colorful_arclight.sql",
      "0019_nice_black_tarantula.sql",
      "0020_brief_gideon.sql",
      "0021_overrated_salo.sql",
      "0022_long_exodus.sql",
      "0023_complete_piledriver.sql",
      "0024_smooth_impossible_man.sql",
      "0025_friendly_maverick.sql",
    ]) {
      await applyMigration(migration);
    }

    const [{ eventId }] = await client<[{ eventId: string }]>`
      insert into workflow_events (
        entity_type, entity_id, event, workflow_name, status, payload
      ) values (
        'system', '00000000-0000-0000-0000-000000000001',
        'legacy.maintenance', 'legacy-maintenance', 'succeeded', '{}'
      ) returning id as "eventId"
    `;

    await applyMigration("0026_maintenance_state.sql");

    const [projection] = await client<
      Array<{ id: number; ownerToken: string | null }>
    >`
      select id, owner_token as "ownerToken" from maintenance_state
    `;
    expect(projection).toEqual({ id: 1, ownerToken: null });

    const [{ eventCount }] = await client<[{ eventCount: number }]>`
      select count(*)::int as "eventCount"
      from workflow_events where id = ${eventId}
    `;
    expect(eventCount).toBe(1);

    await client`
      insert into maintenance_state (id) values (1)
      on conflict (id) do nothing
    `;
    const [{ projectionCount }] = await client<[{ projectionCount: number }]>`
      select count(*)::int as "projectionCount" from maintenance_state
    `;
    expect(projectionCount).toBe(1);
  });

  it("gives every in-flight message a send request clock, and no other message one", async () => {
    for (const migration of [
      "0000_sturdy_kid_colt.sql",
      "0001_pink_luminals.sql",
      "0002_exotic_wind_dancer.sql",
      "0003_woozy_fenris.sql",
      "0004_brief_firedrake.sql",
      "0005_rainy_warbound.sql",
      "0006_sleepy_blade.sql",
      "0007_quiet_scrambler.sql",
      "0008_material_gunslinger.sql",
      "0009_parallel_venom.sql",
      "0010_fancy_quasimodo.sql",
      "0011_sweet_misty_knight.sql",
      "0012_futuristic_meltdown.sql",
      "0013_powerful_viper.sql",
      "0014_futuristic_jean_grey.sql",
      "0015_spooky_the_fallen.sql",
      "0016_first_sersi.sql",
      "0017_wonderful_nekra.sql",
      "0018_colorful_arclight.sql",
      "0019_nice_black_tarantula.sql",
      "0020_brief_gideon.sql",
      "0021_overrated_salo.sql",
      "0022_long_exodus.sql",
      "0023_complete_piledriver.sql",
      "0024_smooth_impossible_man.sql",
      "0025_friendly_maverick.sql",
      "0026_maintenance_state.sql",
    ]) {
      await applyMigration(migration);
    }

    const [{ accountId }] = await client<[{ accountId: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('In Flight', 'in flight', 'in-flight.example')
      returning id as "accountId"
    `;
    const [{ contactId }] = await client<[{ contactId: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'In', 'Flight', 'In Flight', 'in flight')
      returning id as "contactId"
    `;
    const [{ campaignId }] = await client<[{ campaignId: string }]>`
      insert into campaigns (name, type, target_description, status)
      values ('In Flight', 'other', 'Backfill validation', 'active')
      returning id as "campaignId"
    `;
    const [{ versionId }] = await client<[{ versionId: string }]>`
      insert into campaign_versions (campaign_id, version, configuration, published_at)
      values (${campaignId}, 1, '{}', now()) returning id as "versionId"
    `;
    const [{ enrollmentId }] = await client<[{ enrollmentId: string }]>`
      insert into enrollments (campaign_id, campaign_version_id, contact_id)
      values (${campaignId}, ${versionId}, ${contactId})
      returning id as "enrollmentId"
    `;

    // The clock the backfill has to approximate is "when a send was
    // requested", and the only two columns that can stand in for it before it
    // existed are `drafted_at` and, failing that, `updated_at`.
    const draftedAt = new Date("2026-08-16T09:00:00.000Z");
    const updatedAt = new Date("2026-08-16T11:58:00.000Z");
    let step = 0;
    async function legacyMessage(
      status: string,
      stamps: { draftedAt: Date | null },
    ): Promise<string> {
      step += 1;
      const [{ id }] = await client<[{ id: string }]>`
        insert into messages (
          enrollment_id, step_index, direction, outreach_id, subject, body,
          recipient, status, contact_account_id, employment_version,
          drafted_at, updated_at
        ) values (
          ${enrollmentId}, ${step}, 'outbound', ${`in-flight-${step}`},
          'Hello', 'Body', 'in@in-flight.example', ${status}::message_status,
          ${accountId}::uuid, 1,
          ${stamps.draftedAt?.toISOString() ?? null}::timestamptz,
          ${updatedAt.toISOString()}::timestamptz
        ) returning id
      `;
      return id;
    }

    const draftedWithDraft = await legacyMessage("drafted", { draftedAt });
    const draftedWithoutDraft = await legacyMessage("drafted", {
      draftedAt: null,
    });
    const draftCreating = await legacyMessage("draft_creating", {
      draftedAt: null,
    });
    const sending = await legacyMessage("sending", { draftedAt });
    const approved = await legacyMessage("approved", { draftedAt: null });
    const proposed = await legacyMessage("proposed", { draftedAt: null });
    const sent = await legacyMessage("sent", { draftedAt });

    await applyMigration("0027_message_send_requested_at.sql");

    const rows = await client<
      Array<{ id: string; requestedAt: string | null }>
    >`
      select id,
        to_char(send_requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          as "requestedAt"
      from messages
    `;
    const requestedAt = new Map(rows.map((row) => [row.id, row.requestedAt]));

    // In flight when the column shipped: approximated, best source first.
    expect(requestedAt.get(draftedWithDraft)).toBe(draftedAt.toISOString());
    expect(requestedAt.get(sending)).toBe(draftedAt.toISOString());
    // No provider draft ever existed, so the row's last movement stands in.
    expect(requestedAt.get(draftedWithoutDraft)).toBe(updatedAt.toISOString());
    expect(requestedAt.get(draftCreating)).toBe(updatedAt.toISOString());
    // Not in flight: no send is being completed, so there is no request to
    // date. An `approved` row carrying a clock would contradict the column.
    expect(requestedAt.get(approved)).toBeNull();
    expect(requestedAt.get(proposed)).toBeNull();
    expect(requestedAt.get(sent)).toBeNull();
  });
  /**
   * Every migration up to and including `tag`, read from the journal rather
   * than listed by hand.
   *
   * The tests above name their files one by one, which was workable at eleven
   * migrations and is how migrations 0028 onwards came to have no populated
   * coverage at all: nobody extends a thirty-entry literal. The journal is the
   * same order the migrator uses, so this cannot drift from it.
   */
  async function applyMigrationsThrough(tag: string): Promise<void> {
    const journal = JSON.parse(
      await readFile("drizzle/meta/_journal.json", "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const target = journal.entries.find((entry) => entry.tag === tag);
    if (!target) throw new Error(`No migration tagged ${tag}`);
    for (const entry of journal.entries
      .filter((candidate) => candidate.idx <= target.idx)
      .sort((left, right) => left.idx - right.idx)) {
      await applyMigration(`${entry.tag}.sql`);
    }
  }

  /**
   * The address ladder arrives on a database that already holds candidates and
   * messages.
   *
   * Two things could have gone wrong and neither is visible on a fresh
   * database: a `not null` column with a default has to land on populated rows,
   * and the step-uniqueness index is *narrowed* in place — dropped and rebuilt
   * with `address_dead_at is null` added to its predicate — which builds
   * against whatever rows are already there.
   */
  it("brings the address ladder to a populated database", async () => {
    await applyMigrationsThrough("0032_message_send_intent_expiry");
    const [{ accountId }] = await client<[{ accountId: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Populated Ladder', 'populated ladder', 'populated-ladder.example')
      returning id as "accountId"
    `;
    const [{ contactId }] = await client<[{ contactId: string }]>`
      insert into contacts (account_id, first_name, last_name, full_name, normalized_full_name)
      values (${accountId}, 'Alice', 'Legacy', 'Alice Legacy', 'alice legacy')
      returning id as "contactId"
    `;
    for (const [local, pattern, status] of [
      ["alice.legacy", "first.last", "accepted"],
      ["a.legacy", "f.last", "candidate"],
      ["alicelegacy", "firstlast", "candidate"],
    ] as const) {
      await client`
        insert into email_candidates (contact_id, email, normalized_email, domain, pattern, confidence, source, status)
        values (${contactId}, ${`${local}@populated-ladder.example`},
          ${`${local}@populated-ladder.example`}, 'populated-ladder.example',
          ${pattern}, 0.900, 'public_pattern', ${status}::email_candidate_status)
      `;
    }
    const [{ campaignId }] = await client<[{ campaignId: string }]>`
      insert into campaigns (name, type, target_description)
      values ('Legacy', 'commercial_outreach', 'Legacy targets')
      returning id as "campaignId"
    `;
    const [{ versionId }] = await client<[{ versionId: string }]>`
      insert into campaign_versions (campaign_id, version, configuration, published_at)
      values (${campaignId}, 1, '{}', now()) returning id as "versionId"
    `;
    const [{ enrollmentId }] = await client<[{ enrollmentId: string }]>`
      insert into enrollments (campaign_id, campaign_version_id, contact_id)
      values (${campaignId}, ${versionId}, ${contactId})
      returning id as "enrollmentId"
    `;
    const [{ messageId }] = await client<[{ messageId: string }]>`
      insert into messages (
        enrollment_id, step_index, direction, outreach_id, subject, body,
        recipient, status, contact_account_id, employment_version
      ) values (
        ${enrollmentId}, 0, 'outbound', 'legacy-step-zero', 'Hello', 'Body',
        'alice.legacy@populated-ladder.example', 'sent', ${accountId}::uuid, 1
      ) returning id as "messageId"
    `;

    await applyMigration("0033_optimal_jackal.sql");

    // Every row that predates the ladder is on rung one, and nothing else moved.
    const ranks = await client<
      Array<{ ladderRank: number; deadAt: string | null }>
    >`
      select ladder_rank as "ladderRank", dead_at as "deadAt" from email_candidates
    `;
    expect(ranks).toHaveLength(3);
    expect(ranks.every((row) => row.ladderRank === 1)).toBe(true);
    expect(ranks.every((row) => row.deadAt === null)).toBe(true);

    // The narrowed index still refuses a second *live* message at one step.
    await expect(
      client`
        insert into messages (
          enrollment_id, step_index, direction, outreach_id, subject, body,
          recipient, status, contact_account_id, employment_version
        ) values (
          ${enrollmentId}, 0, 'outbound', 'legacy-duplicate', 'Hello', 'Body',
          'a.legacy@populated-ladder.example', 'proposed', ${accountId}::uuid, 1
        )
      `,
    ).rejects.toMatchObject({ code: "23505" });

    // And allows exactly one replacement once the first is proven dead, which
    // is the single fact the predicate was narrowed by.
    await client`
      update messages set address_dead_at = now() where id = ${messageId}
    `;
    await client`
      insert into messages (
        enrollment_id, step_index, direction, outreach_id, subject, body,
        recipient, status, contact_account_id, employment_version
      ) values (
        ${enrollmentId}, 0, 'outbound', 'legacy-readdressed', 'Hello', 'Body',
        'a.legacy@populated-ladder.example', 'proposed', ${accountId}::uuid, 1
      )
    `;
    await expect(
      client`
        insert into messages (
          enrollment_id, step_index, direction, outreach_id, subject, body,
          recipient, status, contact_account_id, employment_version
        ) values (
          ${enrollmentId}, 0, 'outbound', 'legacy-third', 'Hello', 'Body',
          'alicelegacy@populated-ladder.example', 'proposed', ${accountId}::uuid, 1
        )
      `,
    ).rejects.toMatchObject({ code: "23505" });
  });

  /**
   * The settings singleton predates the ladder, so its bounds arrive as column
   * defaults on a row nobody rewrites. A `0` or a `null` there would disable
   * the feature, or open the circuit breaker on the first send, without anybody
   * choosing it.
   */
  it("gives an existing settings row the ladder defaults", async () => {
    await applyMigrationsThrough("0032_message_send_intent_expiry");
    // An earlier migration already seeds the singleton, which is the point:
    // the row the ladder columns land on is one nothing rewrites afterwards.
    await client`insert into operator_sending_settings (id) values (1) on conflict do nothing`;
    const [before] = await client<Array<{ id: number }>>`
      select id from operator_sending_settings where id = 1
    `;
    expect(before?.id).toBe(1);
    await applyMigration("0033_optimal_jackal.sql");
    const [row] = await client<
      Array<{
        enabled: boolean;
        maxRungs: number;
        advances: number;
        ratePercent: number;
        minimumSends: number;
        people: number;
        share: number;
      }>
    >`
      select address_ladder_enabled as "enabled",
        address_ladder_max_rungs as "maxRungs",
        address_ladder_max_advances_per_account_per_day as "advances",
        address_ladder_failure_rate_percent as "ratePercent",
        address_ladder_failure_rate_minimum_sends as "minimumSends",
        address_ladder_demotion_minimum_people as "people",
        address_ladder_demotion_failure_share_percent as "share"
      from operator_sending_settings where id = 1
    `;
    expect(row).toEqual({
      enabled: true,
      maxRungs: 3,
      advances: 2,
      ratePercent: 30,
      minimumSends: 20,
      people: 2,
      share: 50,
    });
  });
});
