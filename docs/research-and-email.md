# Discovery, research, and email resolution

[← Back to the README](../README.md)

Narrow account-discovery, account-research, contact-discovery,
personalization, and reply-classification agents share a strict structured-output
boundary. Every one of them runs on the operator's own ChatGPT desktop app: the
app is driven through its devtools protocol, the turn is typed into the real
composer and the answer is read back from the surface. No API key is involved,
and no network request is reconstructed — the app performs its own request
exactly as it would for a human.

The two lanes differ only in how the picker is set. Research agents run
`AI_RESEARCH_MODEL` at `AI_RESEARCH_EFFORT` (default `GPT-5.6 Sol` at `High`)
and may use the app's web search; personalization and reply classification run
`AI_FAST_MODEL` at `AI_FAST_EFFORT` (default `GPT-5.6 Sol` at `Instant`). Effort
and model are always stated: an unset value would inherit whatever default the
app carries, which is how evidence-bound research silently degrades.

```bash
AI_PROVIDER=chatgpt_desktop
WORKFLOW_PROVIDER=local
AI_RESEARCH_MODEL=GPT-5.6 Sol
AI_RESEARCH_EFFORT=High
AI_RESEARCH_TIMEOUT_MS=600000
AI_FAST_MODEL=GPT-5.6 Sol
AI_FAST_EFFORT=Instant
AI_FAST_TIMEOUT_MS=120000
```

The public-address search names its source families explicitly — the company's
own material, documents written by third parties (programme PDFs, press kits,
tender documents, legal notices, job adverts), and contact or people-search
databases — because companies that publish no address on their own site still
appear in files written by others. It refuses two things by name rather than by
principle: reporting a person whose address the cited page does not actually
show, and reporting an address a page displays masked or truncated. Both are
behaviours a model can check itself against; a general "do not infer" clause
alone did not stop either.

Each turn opens a new chat, switches the app into temporary chat so nothing is
persisted in the account history, selects model and effort, sends the prompt,
waits for the answer to stabilise, and restores the mode it found. Turns are
serialized because the app has a single composer, and each turn carries its own
deadline, counted from the moment the caller asked — including the wait for the
composer to be free. That bound has a visible consequence: while a long
research turn holds the window, a short call queued behind it can exhaust its
own deadline without ever being sent, and fails rather than piling up. The
queue lives in the application process; running `npm run chatgpt` at the same
time drives the same window from outside it.

The app cannot be handed an output schema, so the schema travels in the prompt
and is enforced after the fact by the same Zod schema the rest of the pipeline
uses. An answer that is not a single valid JSON object earns exactly one
correction turn; a second failure fails the task rather than persisting
something unvalidated. Answers are read from the document tree, not the
rendering, so a linkified URL cannot break a JSON string.

Two limits follow from the surface and are treated as facts, not gaps: the app
reports neither token usage nor its searches, so cost is `unavailable` and tool
usage is null rather than an invented zero; and every citation is persisted as
`model_declared_after_search`, because nothing in the surface proves a URL came
from a result set.

`AI_PROVIDER=chatgpt_desktop` requires local workflow execution and is rejected
with `WORKFLOW_PROVIDER=trigger`: a hosted worker has no desktop app to drive.
This is a single-operator arrangement and must not be used to expose one
operator's ChatGPT session to remote users. `/settings` shows the lane models
and efforts, never account identity or secrets.

`AI_PROVIDER=mock` is the default and keeps all AI tasks deterministic and
credential-free. The live mode is opt-in by name because it has side effects on
the operator's own machine: it launches and drives their ChatGPT app.
Configuration failures are explicit: no mode silently falls back to another.

The retired Codex CLI provider is still in the tree under `src/lib/codex/`,
unplugged from the provider factory. It is kept for reference, not selected by
any configuration.

Credential-free development uses deterministic mock agents through the same
interfaces. Each persisted operation records agent/model/prompt/schema versions,
structured input/output, provider response/thread ID, sources, detailed
token/cache/reasoning usage, web-search call count, cost availability/value,
completion state, and sanitized failures in `agent_runs`. Provider sources carry
their provenance strength: desktop-app URLs are model-declared after the
model's own search. Account research has a configurable
freshness TTL, a crash-recoverable
ownership claim that avoids duplicate concurrent calls, and one snapshot reused
by every contact. A global
LinkedIn identity only changes employers when current-employment evidence is
validated; otherwise the result remains an explicit manual conflict. Evidence
retrieval time is server-observed and repeated source URLs refresh provenance.
A validated move increments an employment version, rejects prior email candidates,
resets email resolution, and stops earlier nonterminal enrollments. Outbound
messages are pinned to the account/employment version and sending shares the
contact action lock with moves through provider acceptance, so an old-company
recipient cannot be sent after a committed move.

Personalization does not invoke web search. Its evidence URLs must instead be in
the explicit trusted-source allowlist supplied with persisted account research;
provider output cannot introduce a new URL.

Email resolution obtains public examples through a provenance-bearing
`PublicEmailEvidenceProvider`; the selected live AI provider performs web search
and binds every structured sample to a validated HTTP(S) source with its provider
provenance marker. It ignores examples
from other domains, excludes samples ambiguous across multiple conventions,
deterministically infers supported address conventions, normalizes international
names, and performs replaceable real/mock MX checks. RFC null MX means the domain
does not accept mail; any MX only affects confidence and never proves that a
recipient exists. This installation integrates **no** third-party enrichment
service: `composeEmailResolutionProviders` supplies `null`, and the
`EmailEnrichmentProvider` seam stays available for one that is actually
configured. Standing a no-result stub in that slot instead made every unresolved
contact report `enrichment_no_result` — a diagnosis about a service that was
never asked — and hid the two reasons that matter,
`insufficient_public_evidence` and `low_confidence`. No-result and
transient-failure outcomes remain explicit instead of inventing an address.

**A company is searched once.** The question the model is asked is the company's
convention, not one person's address, so a successful search is reused for every
other contact at that account for thirty days
(`DEFAULT_PUBLIC_EVIDENCE_TTL_MS`). Reuse is read from the audit trail, which
already records each search with its domain, result and completion time, so
there is no second store to disagree with the record. Three things are never
reused: a search that found nothing — the same prompt on the same domain has
returned zero, one and two addresses on consecutive attempts, so caching the
worst draw would retire a company a second look resolves — a record older than
the lifetime, and a record made by an earlier prompt version, which is what
makes improving the prompt reach companies already searched. **Force a fresh
company search** on the contact page overrides all of it and spends a live web
search. Each candidate records which search it rests on and whether that search
was fresh or reused, shown beside its address convention.

**Resolving addresses is an action on a company.** `/prospects` offers it on each
company row with the number of contacts it would act on, and the contact page
offers the same button; the per-contact action survives beside it for the
exception — somebody who just changed employer, a manual addition — rather than
being the normal path. One click queues one resolution per contact, and only the
first carries a forced re-search, so a ten-person company can never spend ten live
searches. Two contacts are never included: one already resolved (unless the search
is forced), and one whose accepted address has already been written to, because
moving the address of somebody who may be holding a message would make that
message unsendable and could end with two addresses used for one human.

DNS and conventional enrichment retain their short provider deadline.
AI public-evidence research has its own deadline, `AI_RESEARCH_TIMEOUT_MS`
(600 seconds by default), because it is web research like any other research
call. All remain abortable and deadline-bound. A claim fenced by
contact/account/domain/employment version keeps
late old-employer results from persisting. PostgreSQL permits at most one accepted
address per contact, and later resolutions replace it transactionally. Contacts
durably retain a typed outcome reason (including missing domain,
insufficient evidence, missing MX, provider failure, an exhausted ladder, a ladder
bound, or every remaining address being suppressed) for UI and operational
inspection. SMTP recipient probing is not used.
