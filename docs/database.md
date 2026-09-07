# Database workflow and schema

[← Back to the README](../README.md)

`npm install` and `npm ci` run the source-pinned PostgreSQL driver repair in
`scripts/patch-postgres.mjs`. If installation uses `--ignore-scripts`, run
`npm run postinstall` explicitly before tests, build, or startup. The patch fixes
reserved-connection cleanup and transaction ownership under load; its native
regressions are in `tests/integration/action-lock-cleanup-production.test.ts`.
It refuses an unexpected driver version or source, so a PostgreSQL dependency
upgrade must include review of whether the upstream release incorporates these
fixes.

The application also checks the repair revision on the imported driver before
creating or reusing its SQL client. An absent or partial repair refuses DB-backed
work with a postinstall/rebuild/restart instruction, including in the bundled
Next server and plain Node workers. This check performs no runtime file scans or
automatic patching. A Next process may still listen, but its database health check
cannot succeed until the installed driver and application build are repaired.

- `npm run db:generate` generates a migration after a schema change.
- `npm run db:migrate` applies the repository-visible migration history.
- `npm run db:check` validates migration-history consistency.
- `npm run db:up` starts PostgreSQL and idempotently provisions the disposable
  `hyperoutreach_test` database, including when the Docker volume already exists.
- `npm run test:mail:up` starts GreenMail for the SMTP/IMAP integration tests.
  Stop it afterwards with `npm run test:mail:down`; normal application use does
  not need this test server.
- `npm run db:down` stops and removes both dependency containers, including
  GreenMail if started; it preserves the PostgreSQL data volume.
- `npm run db:seed:mock` idempotently creates the explicit local-demo mock
  mailbox; `db:seed` is only a compatibility alias.
- `npm run test:integration` rebuilds the test database's `public` schema,
  applies the repository-visible migrations through Drizzle, and proves the material
  relational constraints against PostgreSQL. It uses `TEST_DATABASE_URL` rather
  than the application `DATABASE_URL`. Do not point `TEST_DATABASE_URL` at a
  database containing data you need.

Integration tests refuse to start when the test and application URLs are equal,
when they name the same database through different connection URLs, or when the
test database name does not end in `_test`. The checked-in defaults use separate
`hyperoutreach` and `hyperoutreach_test` databases on the same local server.

## Local startup prerequisites

Start the Docker runtime before the database, then start ChatGPT Desktop and the
application stack. With Colima on macOS, PostgreSQL runs in
its local VM, published at `127.0.0.1:55432`, with data in the Docker volume
`hyperoutreach_hyperoutreach_postgres_data`. The SSH listener on that port is
Colima's local forwarding, not evidence of a remote database server.

Compose declares `restart: unless-stopped` for PostgreSQL. After this
configuration is applied, Docker can restart the container when the daemon
returns; a deliberately stopped container stays stopped. This does not start
Colima, ChatGPT Desktop, or Hyperoutreach at host boot. See the
[Docker restart policy semantics](https://docs.docker.com/engine/containers/start-containers-automatically/).
Apply the Compose configuration with `npm run db:up` during a planned stack
restart; editing the file alone does not update an existing container's policy.

## Restoring an outreach database

A database backup cannot undo mail already accepted by an SMTP server. An older
archive can lose the local acceptance journal while the recipient still has the
message. A deterministic Message-ID does not make SMTP delivery idempotent.

1. Stop the web server and every maintenance/Trigger/CLI process that can use the
   database. Restore into a separate database and retain the previous database
   for comparison; do not resume the restored installation yet.
2. Before starting any application process, enable the existing emergency pause
   in the restored database and verify the single settings row:

   ```sql
   UPDATE operator_sending_settings SET emergency_pause = true WHERE id = 1;
   SELECT id, emergency_pause FROM operator_sending_settings;
   ```

   Expect exactly one row, with `id = 1` and `emergency_pause = true`. A missing
   row or failed statement is a stop condition. Run these statements against
   the restored target, with the normal application processes still stopped.

3. Keep the pause enabled while comparing the archive time with later send
   attempts, acceptance records and external mail evidence. Restore the token
   encryption keyring as well as the database. Preserve uncertain outcomes;
   never clear an attempt or resubmit merely because a Sent copy is missing.
4. Resume sending only after potentially newer deliveries are accounted for.
   If that evidence is unavailable, retain the pause for the affected workload.
   Starting the stack successfully is not evidence that replaying an old send
   request is safe.

The emergency pause blocks delivery; it is not an offline forensic mode.
Maintenance can still read mail, classify replies and reconcile prior outcomes
once restarted. Keep the processes stopped if those operations are not intended.
Backup scheduling, retention and host auto-start are not configured by this
repository.

The schema records accounts, contacts, evidence, email candidates, campaigns and
immutable versions, sequence steps, mailboxes, enrollments, messages, inbound
deduplication records, replies, suppressions, workflow events, agent runs, and
state transitions. Explicit enums represent lifecycle state. Unique/partial
indexes and composite foreign keys prevent the key duplicate cases without
conflating same-name accounts with different domains or same-name contacts with
different LinkedIn identities. Evidence belongs to exactly one account or
contact and is URL-deduplicated within that owner. Database triggers make
campaign versions and their steps immutable after an enrollment uses them.
Historical `used_at` state remains after enrollment deletion, and an enrollment's
campaign, version, and contact identity cannot be repinned after insert;
operational state and mailbox assignment remain updateable. Tables with an
`updated_at` column advance it automatically on update.

Account creation and AI discovery share one conservative identity policy. An
exact normalized domain always reuses its account. A newly supplied domain may
enrich the single same-name domainless account; a domainless input may reuse a
single unambiguous same-name account. When several same-name accounts have
different domains, Hyperoutreach refuses the automatic merge and requires a
domain instead of choosing an arbitrary oldest row. Contact discovery reports
validated known identities through the same global LinkedIn/company-scoped
fallback constraints; rerunning it may consume another provider call but cannot
create a duplicate strong identity.
