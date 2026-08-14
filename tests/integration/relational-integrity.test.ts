import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDatabaseUrls } from "@/lib/db/test-database";

const { testUrl: databaseUrl } = resolveDatabaseUrls(process.env);

const client = postgres(databaseUrl, { max: 1 });

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("committed PostgreSQL migration", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("uses domainless names as fallback identity while allowing shared names across domains", async () => {
    await client`
      insert into accounts (name, normalized_name, domain)
      values ('No Domain Corp', 'no domain corp', null)
    `;

    await expectDatabaseError(
      () => client`
        insert into accounts (name, normalized_name, domain)
        values ('No Domain Corporation', 'no domain corp', null)
      `,
      "23505",
    );

    await client`
      insert into accounts (name, normalized_name, domain)
      values
        ('Shared Name France', 'shared name', 'shared-name.fr'),
        ('Shared Name US', 'shared name', 'shared-name.com')
    `;
    await expectDatabaseError(
      () => client`
        insert into accounts (name, normalized_name, domain)
        values ('Different Name', 'different name', 'shared-name.fr')
      `,
      "23505",
    );
  });

  it("uses account/name as fallback contact identity while allowing distinct LinkedIn identities", async () => {
    const [{ id: accountId }] = await client<[{ id: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Contact Corp', 'contact corp', 'contact.example')
      returning id
    `;
    await client`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Alice', 'Doe', 'Alice Doe', 'alice doe')
    `;

    await expectDatabaseError(
      () => client`
        insert into contacts (
          account_id, first_name, last_name, full_name, normalized_full_name
        ) values (${accountId}, 'ALICE', 'DOE', 'Alice Doe', 'alice doe')
      `,
      "23505",
    );

    await client`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name,
        linkedin_url
      ) values
        (${accountId}, 'Chris', 'Lee', 'Chris Lee', 'chris lee',
          'https://www.linkedin.com/in/chris-lee-one'),
        (${accountId}, 'Chris', 'Lee', 'Chris Lee', 'chris lee',
          'https://www.linkedin.com/in/chris-lee-two')
    `;
    await expectDatabaseError(
      () => client`
        insert into contacts (
          account_id, first_name, last_name, full_name, normalized_full_name,
          linkedin_url
        ) values (
          ${accountId}, 'Christopher', 'Lee', 'Christopher Lee',
          'christopher lee', 'https://www.linkedin.com/in/chris-lee-one'
        )
      `,
      "23505",
    );
  });

  it("requires exactly one evidence owner and deduplicates its URL", async () => {
    const [{ id: accountId }] = await client<[{ id: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Evidence Corp', 'evidence corp', 'evidence.example')
      returning id
    `;
    const [{ id: contactId }] = await client<[{ id: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Erin', 'Page', 'Erin Page', 'erin page')
      returning id
    `;

    await client`
      insert into evidence_sources (account_id, url, source_type)
      values (${accountId}, 'https://evidence.example/account', 'website')
    `;
    await expectDatabaseError(
      () => client`
        insert into evidence_sources (account_id, url, source_type)
        values (${accountId}, 'https://evidence.example/account', 'website')
      `,
      "23505",
    );

    await client`
      insert into evidence_sources (contact_id, url, source_type)
      values (${contactId}, 'https://evidence.example/contact', 'profile')
    `;
    await expectDatabaseError(
      () => client`
        insert into evidence_sources (contact_id, url, source_type)
        values (${contactId}, 'https://evidence.example/contact', 'profile')
      `,
      "23505",
    );

    await expectDatabaseError(
      () => client`
        insert into evidence_sources (url, source_type)
        values ('https://evidence.example/unowned', 'website')
      `,
      "23514",
    );
    await expectDatabaseError(
      () => client`
        insert into evidence_sources (account_id, contact_id, url, source_type)
        values (
          ${accountId}, ${contactId}, 'https://evidence.example/two-owners',
          'website'
        )
      `,
      "23514",
    );
  });

  it("permits at most one accepted email candidate per contact", async () => {
    const [{ id: accountId }] = await client<[{ id: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Accepted Email Corp', 'accepted email corp', 'accepted.example')
      returning id
    `;
    const [{ id: contactId }] = await client<[{ id: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Accept', 'One', 'Accept One', 'accept one')
      returning id
    `;
    await client`
      insert into email_candidates (
        contact_id, email, normalized_email, domain, confidence, source, status
      ) values (
        ${contactId}, 'first@accepted.example', 'first@accepted.example',
        'accepted.example', 0.9, 'fixture', 'accepted'
      )
    `;
    await expectDatabaseError(
      () => client`
        insert into email_candidates (
          contact_id, email, normalized_email, domain, confidence, source, status
        ) values (
          ${contactId}, 'second@accepted.example', 'second@accepted.example',
          'accepted.example', 0.9, 'fixture', 'accepted'
        )
      `,
      "23505",
    );
  });

  it("advances updated_at without caller intervention", async () => {
    const [{ id: accountId }] = await client<[{ id: string }]>`
      insert into accounts (name, normalized_name, domain, updated_at)
      values ('Timestamp Corp', 'timestamp corp', 'timestamp.example', '2000-01-01')
      returning id
    `;
    const [{ updatedAt }] = await client<[{ updatedAt: string }]>`
      update accounts set industry = 'Software' where id = ${accountId}
      returning updated_at as "updatedAt"
    `;
    expect(Date.parse(updatedAt)).toBeGreaterThan(Date.parse("2000-01-01"));

    const [{ triggerCount }] = await client<[{ triggerCount: number }]>`
      select count(*)::int as "triggerCount"
      from pg_trigger
      where not tgisinternal and tgname like '%_set_updated_at'
    `;
    expect(triggerCount).toBe(7);
  });

  it("rejects enrolling one contact twice in the same campaign across versions", async () => {
    const [{ id: accountId }] = await client<[{ id: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Enroll Corp', 'enroll corp', 'enroll.example')
      returning id
    `;
    const [{ id: contactId }] = await client<[{ id: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Eve', 'Smith', 'Eve Smith', 'eve smith')
      returning id
    `;
    const [{ id: campaignId }] = await client<[{ id: string }]>`
      insert into campaigns (name, type, target_description)
      values ('Discovery', 'customer_discovery', 'Operators of B2B software')
      returning id
    `;
    const versions = await client<[{ id: string }, { id: string }]>`
      insert into campaign_versions (campaign_id, version, configuration)
      values (${campaignId}, 1, '{}'), (${campaignId}, 2, '{}')
      returning id
    `;
    await client`
      insert into enrollments (campaign_id, campaign_version_id, contact_id)
      values (${campaignId}, ${versions[0].id}, ${contactId})
    `;

    await expectDatabaseError(
      () => client`
        insert into enrollments (campaign_id, campaign_version_id, contact_id)
        values (${campaignId}, ${versions[1].id}, ${contactId})
      `,
      "23505",
    );
  });

  it("rejects duplicate outbound sends for an enrollment step", async () => {
    const [{ id: accountId }] = await client<[{ id: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Message Corp', 'message corp', 'message.example')
      returning id
    `;
    const [{ id: contactId }] = await client<[{ id: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Maya', 'Ray', 'Maya Ray', 'maya ray')
      returning id
    `;
    const [{ id: campaignId }] = await client<[{ id: string }]>`
      insert into campaigns (name, type, target_description)
      values ('Message Campaign', 'commercial_outreach', 'Finance leaders')
      returning id
    `;
    const [{ id: versionId }] = await client<[{ id: string }]>`
      insert into campaign_versions (campaign_id, version, configuration)
      values (${campaignId}, 1, '{}') returning id
    `;
    await client`
      insert into sequence_steps (
        campaign_version_id, step_index, delay_minutes, subject_template,
        body_template
      ) values (${versionId}, 0, 0, 'Hello', 'Hello {{first_name}}')
    `;
    const [{ id: enrollmentId }] = await client<[{ id: string }]>`
      insert into enrollments (campaign_id, campaign_version_id, contact_id)
      values (${campaignId}, ${versionId}, ${contactId}) returning id
    `;
    await client`
      insert into messages (
        enrollment_id, step_index, direction, outreach_id, subject, body,
        recipient, status, contact_account_id, employment_version
      ) values (
        ${enrollmentId}, 0, 'outbound', 'out_test_one', 'Hello', 'Body',
        'maya@message.example', 'proposed', ${accountId}, 1
      )
    `;

    await expectDatabaseError(
      () => client`
        insert into messages (
          enrollment_id, step_index, direction, outreach_id, subject, body,
          recipient, status, contact_account_id, employment_version
        ) values (
          ${enrollmentId}, 0, 'outbound', 'out_test_two', 'Again', 'Body',
          'maya@message.example', 'proposed', ${accountId}, 1
        )
      `,
      "23505",
    );
  });

  it("rejects duplicate inbound provider messages", async () => {
    const [{ id: mailboxId }] = await client<[{ id: string }]>`
      insert into mailbox_connections (provider, email, normalized_email)
      values ('mock', 'operator@example.com', 'operator@example.com')
      returning id
    `;
    await client`
      insert into inbound_records (
        mailbox_id, provider_message_id, event_type, payload_hash
      ) values (${mailboxId}, 'provider-message-1', 'message_received', 'hash-1')
    `;

    await expectDatabaseError(
      () => client`
        insert into inbound_records (
          mailbox_id, provider_message_id, event_type, payload_hash
        ) values (${mailboxId}, 'provider-message-1', 'delta_recovered', 'hash-2')
      `,
      "23505",
    );
  });

  it("rejects duplicate global suppression entries", async () => {
    await client`
      insert into suppression_entries (scope, normalized_value, reason)
      values ('email', 'opted-out@example.com', 'unsubscribe')
    `;

    await expectDatabaseError(
      () => client`
        insert into suppression_entries (scope, normalized_value, reason)
        values ('email', 'opted-out@example.com', 'manual')
      `,
      "23505",
    );
  });

  it("prevents mutation of campaign versions and steps after enrollment", async () => {
    const [{ id: accountId }] = await client<[{ id: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Immutable Corp', 'immutable corp', 'immutable.example')
      returning id
    `;
    const [{ id: contactId }] = await client<[{ id: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Ivy', 'Stone', 'Ivy Stone', 'ivy stone')
      returning id
    `;
    const [{ id: campaignId }] = await client<[{ id: string }]>`
      insert into campaigns (name, type, target_description)
      values ('Immutable Campaign', 'customer_discovery', 'Product leaders')
      returning id
    `;
    const [{ id: versionId }] = await client<[{ id: string }]>`
      insert into campaign_versions (campaign_id, version, configuration)
      values (${campaignId}, 1, '{"mode":"manual"}') returning id
    `;
    const [{ id: stepId }] = await client<[{ id: string }]>`
      insert into sequence_steps (
        campaign_version_id, step_index, delay_minutes, subject_template,
        body_template
      ) values (${versionId}, 0, 0, 'Original', 'Original body') returning id
    `;
    const [mutableVersion] = await client<
      [{ configuration: { mode: string } }]
    >`
      update campaign_versions set configuration = '{"mode":"assisted"}'
      where id = ${versionId} returning configuration
    `;
    expect(mutableVersion.configuration).toEqual({ mode: "assisted" });
    const [mutableStep] = await client<[{ subject: string }]>`
      update sequence_steps set subject_template = 'Still mutable'
      where id = ${stepId} returning subject_template as subject
    `;
    expect(mutableStep.subject).toBe("Still mutable");
    await client`
      insert into enrollments (campaign_id, campaign_version_id, contact_id)
      values (${campaignId}, ${versionId}, ${contactId})
    `;

    await expectDatabaseError(
      () => client`
        update campaign_versions set configuration = '{"mode":"automatic"}'
        where id = ${versionId}
      `,
      "23514",
    );
    await expectDatabaseError(
      () => client`
        update sequence_steps set subject_template = 'Changed' where id = ${stepId}
      `,
      "23514",
    );
  });

  it("rejects moving an unused step into a historically used version", async () => {
    const [{ id: accountId }] = await client<[{ id: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Moved Step Corp', 'moved step corp', 'moved-step.example')
      returning id
    `;
    const [{ id: contactId }] = await client<[{ id: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Nina', 'Cole', 'Nina Cole', 'nina cole')
      returning id
    `;
    const [{ id: campaignId }] = await client<[{ id: string }]>`
      insert into campaigns (name, type, target_description)
      values ('Moved Step Campaign', 'customer_discovery', 'Operations leaders')
      returning id
    `;
    const versions = await client<[{ id: string }, { id: string }]>`
      insert into campaign_versions (campaign_id, version, configuration)
      values (${campaignId}, 1, '{}'), (${campaignId}, 2, '{}')
      returning id
    `;
    const [{ id: unusedStepId }] = await client<[{ id: string }]>`
      insert into sequence_steps (
        campaign_version_id, step_index, delay_minutes, subject_template,
        body_template
      ) values (${versions[1].id}, 0, 0, 'Unused', 'Unused body') returning id
    `;
    await client`
      insert into enrollments (campaign_id, campaign_version_id, contact_id)
      values (${campaignId}, ${versions[0].id}, ${contactId})
    `;

    await expectDatabaseError(
      () => client`
        update sequence_steps set campaign_version_id = ${versions[0].id}
        where id = ${unusedStepId}
      `,
      "23514",
    );
  });

  it("keeps enrollment identity fixed and version history immutable", async () => {
    const [{ id: accountId }] = await client<[{ id: string }]>`
      insert into accounts (name, normalized_name, domain)
      values ('Pinned Corp', 'pinned corp', 'pinned.example')
      returning id
    `;
    const [{ id: contactId }] = await client<[{ id: string }]>`
      insert into contacts (
        account_id, first_name, last_name, full_name, normalized_full_name
      ) values (${accountId}, 'Omar', 'Bell', 'Omar Bell', 'omar bell')
      returning id
    `;
    const [{ id: campaignId }] = await client<[{ id: string }]>`
      insert into campaigns (name, type, target_description)
      values ('Pinned Campaign', 'commercial_outreach', 'Revenue leaders')
      returning id
    `;
    const versions = await client<[{ id: string }, { id: string }]>`
      insert into campaign_versions (campaign_id, version, configuration)
      values (${campaignId}, 1, '{}'), (${campaignId}, 2, '{}')
      returning id
    `;
    const mailboxes = await client<[{ id: string }, { id: string }]>`
      insert into mailbox_connections (provider, email, normalized_email)
      values
        ('mock', 'pinned@example.com', 'pinned@example.com'),
        ('mock', 'other@example.com', 'other@example.com')
      returning id
    `;
    const [{ id: enrollmentId }] = await client<[{ id: string }]>`
      insert into enrollments (
        campaign_id, campaign_version_id, contact_id, mailbox_id
      ) values (
        ${campaignId}, ${versions[0].id}, ${contactId}, ${mailboxes[0].id}
      ) returning id
    `;

    await expectDatabaseError(
      () => client`
        update enrollments set campaign_version_id = ${versions[1].id}
        where id = ${enrollmentId}
      `,
      "23514",
    );
    const [{ usedAt }] = await client<[{ usedAt: string | null }]>`
      select used_at as "usedAt" from campaign_versions where id = ${versions[0].id}
    `;
    expect(usedAt).not.toBeNull();

    await expectDatabaseError(
      () => client`
        update enrollments set mailbox_id = ${mailboxes[1].id}
        where id = ${enrollmentId}
      `,
      "23514",
    );
    await expectDatabaseError(
      () => client`
        update enrollments set mailbox_id = null where id = ${enrollmentId}
      `,
      "23514",
    );
    const [operationalUpdate] = await client<[{ state: string }]>`
      update enrollments set state = 'approved' where id = ${enrollmentId}
      returning state
    `;
    expect(operationalUpdate).toEqual({ state: "approved" });

    await client`delete from enrollments where id = ${enrollmentId}`;
    await expectDatabaseError(
      () => client`
        update campaign_versions set configuration = '{"mode":"automatic"}'
        where id = ${versions[0].id}
      `,
      "23514",
    );
  });

  it("creates exactly one durable maintenance projection and its history index", async () => {
    const rows = await client<
      Array<{
        id: number;
        ownerToken: string | null;
        cycleStartedAt: string | null;
        heartbeatAt: string | null;
        lastSucceededAt: string | null;
        lastFailedAt: string | null;
        lastError: string | null;
      }>
    >`
      select
        id,
        owner_token as "ownerToken",
        cycle_started_at as "cycleStartedAt",
        heartbeat_at as "heartbeatAt",
        last_succeeded_at as "lastSucceededAt",
        last_failed_at as "lastFailedAt",
        last_error as "lastError"
      from maintenance_state
    `;
    expect(rows).toEqual([
      {
        id: 1,
        ownerToken: null,
        cycleStartedAt: null,
        heartbeatAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
      },
    ]);

    await expectDatabaseError(
      () => client`insert into maintenance_state (id) values (2)`,
      "23514",
    );

    const [{ indexCount }] = await client<[{ indexCount: number }]>`
      select count(*)::int as "indexCount"
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'workflow_events'
        and indexname = 'workflow_events_workflow_created_idx'
    `;
    expect(indexCount).toBe(1);
  });
});
