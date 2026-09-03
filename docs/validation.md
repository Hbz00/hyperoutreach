# Validation

[← Back to the README](../README.md)

With PostgreSQL running and migrated:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run eval
npm run build
```

Two probes sit beside that suite and are deliberately **not** part of it,
because each spends live turns on the operator's own ChatGPT window and must be
run deliberately, with the maintenance worker stopped:

```bash
npm run probe:personalization -- --runs 10
npm run probe:public-email -- --domain acme.example,globex.example
```

The first measures whether the fast lane holds the personalization contract. The
second compares the shipped public-address prompt against a candidate over the
same domains, scoring both with the production pattern inference so a win means
a contact would actually resolve. It reads the live database read-only, writes
nothing, and refuses to start while a maintenance lease is alive. Its verifier
is an ordinary HTTP client, so it can confirm an address on a readable page and
can never confirm one on LinkedIn or a contact database — those answer 999 and
403 to anything but the app itself. Read its `unverified` column, which means a
readable page that did not contain the address, as the only evidence of a
fabrication; `unreadable` means out of reach, not discredited.

`npm run eval` loads the schema-validated, versioned fixture at
`evals/fixtures/v1.json`. It reports account/contact precision, required-fact
evidence support, email address/confidence/reason accuracy, labelled
personalization acceptance, reply/state/suppression outcomes, deterministic
send-policy decisions, and duplicate-normalization outcomes. Evidence support
counts only exact URL–fact pairs present in the independently labelled expected
set; a model's own `supports` declaration cannot validate itself. Every metric has a
fixture-declared threshold; the process exits nonzero if any one regresses. The
fixture is deliberately credential-free and contains frozen structured output
shapes plus synthetic expected judgments, so it is reproducible in CI. When
comparing a new model or prompt, create a new versioned fixture (do not rewrite
prior ground truth), replace its predicted/observed fields with captured
schema-valid outputs from an independently human-labelled dataset, review the
acceptance labels, and declare new thresholds explicitly.

The bundled `v1` data contains 100 explicit synthetic captured-output cases. It
is a contract/regression baseline, not a claim of real-world model quality. It
proves the measurement and regression machinery without network credentials.
Production calibration still requires a separate dataset of roughly 100 real
prospects whose company, person, role, email, evidence, and personalization are
manually verified, followed by capturing each model/prompt candidate's
structured outputs into a new immutable fixture version.

Install the pinned Playwright browser once and run the critical workflow tests:

```bash
npx playwright install chromium
npm run test:e2e
# On a host that permits Chromium, include the actual rendered interaction test:
RUN_BROWSER_E2E=1 npm run test:e2e
```

The Playwright configuration builds and serves the production application rather
than using the development watcher, which makes the test closer to deployment
behavior and avoids low file-descriptor limits on some machines. It never reuses
an existing server, force-selects all mock providers, and provisions only the
disposable `hyperoutreach_e2e_test` database, resetting its schema on every run,
so tests cannot send through or mutate a configured live installation.

The opt-in page-driven test uses only rendered forms, links, and buttons to encode
the complete create/dedupe/research/evidence/resolve/campaign/enroll/review/send/
follow-up/reply/stop/suppress/blocked-send lifecycle. A real Chromium run exposed
and drove the fix for a cross-host authentication redirect (`127.0.0.1` cookie
followed by `localhost`). UI redirects are now relative, the server is explicitly
bound to `127.0.0.1`, and E2E credentials come from one forced shared fixture.
The full post-fix rendered lifecycle passed in Chromium in 8.3 seconds.
