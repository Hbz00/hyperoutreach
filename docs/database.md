# Database workflow and schema

[← Back to the README](../README.md)

- `npm run db:generate` generates a migration after a schema change.
- `npm run db:migrate` applies the repository-visible migration history.
- `npm run db:check` validates migration-history consistency.
- `npm run db:up` starts PostgreSQL and idempotently provisions the disposable
  `hyperoutreach_test` database, including when the Docker volume already exists.
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
