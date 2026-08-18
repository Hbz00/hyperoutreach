# Company Address Convention and Attempt Ladder — Design

Date: 2026-08-17

Status: **approved 2026-08-18, and being built.** The directions below are
settled. The seven questions that were open are answered in _Decisions taken_,
together with two places where the answers made a stated direction redundant and
it was deliberately not built. Nothing in the body of this document was
reversed; read _Decisions taken_ as the part that turns it into an
implementation.

## Problem

An address convention belongs to a company, but the product asks for it one
person at a time. The operator opens a contact, presses _Resolve email_, and
repeats that for every colleague — for an answer that was established once, for
the whole account, by a single web search.

Two consequences follow. The obvious one is repetition. The less obvious one is
that a company whose convention is known still yields nothing for the nine
colleagues nobody clicked, so a discovered account stays half-unusable for no
reason.

There is a second, larger gap. When the inferred convention turns out to be
wrong for a given person, the product has no answer. The address was accepted,
the message bounced, and the enrollment stopped permanently. Nothing tries the
next best convention, even when the evidence named one.

## What already exists

Stated so this is not rebuilt. Everything below is in the tree today.

- The public-address search is keyed on the company domain, not the person, and
  its result is reused for every other contact of that account for thirty days.
- Inference returns **every** convention the samples support, each with its own
  evidence count, ordered by that count. A ranking already exists.
- For a given contact, an address is already generated **per surviving
  convention**, and every one of them is persisted as a candidate row. Only the
  best-evidenced one is accepted. The material for a second attempt is already
  in the database.
- When two conventions tie above the acceptance threshold, the product refuses
  to choose and sends the contact to manual review.
- A hard bounce is terminal: it stops the enrollment, marks it `bounced`, and
  writes a permanent suppression for the recipient address.

## Direction

Make the convention a first-class property of the account, and make address
selection an ordered ladder rather than a single verdict.

Three shifts, in decreasing order of confidence that they are right:

**The account becomes the unit of resolution.** Resolving addresses is an action
on a company; its contacts inherit the result. The per-contact action survives
for the exception — a contact who just changed employer, a manual addition — but
stops being the normal path.

**Every contact carries an ordered ladder, not one address.** Rung one is the
best-evidenced convention. Later rungs are the other conventions the evidence
named, in order. A contact whose company showed one convention has a
one-rung ladder, and that is a complete, valid state — not a degraded one.

**A proven-dead address advances the ladder instead of ending the person.**
Today a hard bounce ends the enrollment and suppresses the address. Those are
two different facts, and the product currently conflates them: the address is
dead, the person is not. The direction is to keep the suppression of the address
and let the sequence continue at the next rung.

## The decision this rests on, recorded

The operator's position, taken deliberately and against the objections raised
during design:

- Testing an address by sending to it costs bounce reputation. Accepted. The
  alternatives are a paid data provider, which is refused, or not reaching the
  prospect at all. At zero marginal cost and a reported ~90% success rate in the
  operator's own outreach experience, the trade is judged worth it.
- A wrong address may reach a real, wrong person. Accepted as a cost of volume.
- Silence after a send does not prove delivery. Contested: the operator's
  experience is that non-existent recipients are reported back in practice on
  the domains being targeted. This spec does not assume either way — see
  _Signals_.

These are product decisions, not engineering ones, and they are recorded here so
a later reviewer does not reopen them as findings.

## The ladder, and what may be on it

The central question is what a rung may be built from.

The default direction: **a rung requires evidence.** A convention nobody
observed is a guess, and the whole resolution path exists to refuse guesses. A
company that showed six addresses in one form and none in any other has one
rung. When that rung dies, the ladder is exhausted and the contact becomes
unreachable — a stated, visible outcome, not a silent failure.

The alternative worth weighing rather than dismissing: after a rung dies, the
population of plausible conventions is much smaller than before, and trying the
most common unevidenced form may beat giving up. It is a different product with
a different risk profile, and it should be an explicit setting rather than a
default. It is listed as an open decision.

Ordering within evidenced rungs follows evidence count. Ties between rungs are
the case the product currently refuses; under a ladder they stop being a
dead-end, because a tie simply means two rungs whose order is arbitrary and
whose second is reached only if the first dies.

## Signals: what counts as a dead address

The ladder advances on proof that an address does not exist. Getting this wrong
in either direction is expensive: advancing too eagerly sends a second message
to a person who received the first, and advancing too reluctantly abandons
reachable prospects.

Directions:

- Only a **hard** delivery failure advances the ladder. Soft failures,
  greylisting, quota and transient refusals do not; they are already handled by
  the existing retry path and must stay there.
- A delivery failure that names a different recipient than the one addressed, or
  arrives without a usable identity, must not advance anything.
- Silence is not a signal, in either direction. It must not be read as delivery,
  and it must not be read as failure.
- Whether the target population reports failures reliably is an empirical
  question this feature is well placed to answer. The design should make the
  answer observable — how many sends produced an explicit failure, how many
  produced nothing at all — rather than assuming the operator's experience
  generalises to French mid-market carriers.

## Learning from delivery outcomes

Public samples are indirect evidence: somebody's address appeared in a document.
Delivery outcomes are direct evidence about the same question, and the ladder
produces them as a by-product. A convention that fails for three different
people at one company has told us something about that company, not just about
those three — yet nothing in the product, or in this design so far, carries that
back to the other contacts. They would go on attempting a form just observed to
fail.

Closing that loop is the point of this section. It is also the part with the
most ways to be wrong.

### The confound that governs the whole idea

**A hard bounce does not distinguish a wrong address shape from a person who has
left.** Contact discovery reads profiles of unknown age, so a share of every
discovered set has already moved on. Each of those people bounces on a perfectly
correct convention.

For a segment with stale contact data this may be the _dominant_ source of hard
bounces, which inverts the naive design: a rule like "three failures demote the
convention" would demote true conventions most aggressively at exactly the
companies where discovery is weakest. A feedback loop that learns fastest where
the data is worst is not a feature.

Directions, with the exact rule left open:

- Demotion evidence must come from **distinct people**. A single failure never
  demotes anything, whatever else is true.
- A failure counts against a convention only relative to how much that
  convention has been attempted at the same company. One failure out of one
  attempt and one out of twenty are not the same fact.
- Nothing about a departed employee should be inferred from the ladder alone.
  Where the product already knows employment is stale, that knowledge belongs in
  the same judgement.

### Failure-only, by construction

Outcome evidence can **demote a convention and never confirm one.** This follows
from _Signals_: silence is not a signal in either direction, so a send that
produced no delivery failure says nothing about whether the address was right.

The consequence is worth stating plainly because it constrains every rule built
on top: any rate computed here has "sends attempted" as its denominator, never
"sends delivered", and the loop can only ever push a convention down the order.
A convention rises only by acquiring more public samples.

### What re-ranking may and may not touch

**A person whose send produced no delivery failure must never be re-addressed.**
They may well have received the message. Sending them a second copy at a
different address is a duplicate delivery to the same human, which the entire
send policy exists to prevent, and no amount of new evidence about their
employer justifies it.

Re-ranking a company's conventions may therefore affect only two populations:
contacts not yet written to, and contacts whose own address was proven dead.
Everyone else keeps what they got.

## Consequences for enrollment state

This is the most sensitive part of the change and the reason to scope it
carefully.

The enrollment state model treats a hard bounce as terminal. Splitting "this
address is dead" from "this person is done" touches the machine that decides
whether anyone is ever written to again. Directions:

- The suppression written for a dead address must remain, permanently, and must
  keep blocking that address across every campaign. Advancing the ladder must
  never reopen an address that failed.
- Advancing must not consume a sequence step. The prospect received nothing; a
  re-addressed first message is still the first message, and follow-up timing
  should count from the most recent attempt that was **not proven dead** —
  never from "the one that landed", which is a fact the _Signals_ section says
  the product cannot establish.
- An exhausted ladder must reach the same terminal state a bounce reaches today.
  The product loses a prospect for the same reason as before; it just tried
  harder first.
- Whether an advance is automatic or offered to the operator is an open
  decision. Automatic favours volume; offered favours control and matches the
  invariant that no first send is system-originated.

## What the operator must be able to see

Explicitly requested, and the part most likely to be under-built.

- On the company: the conventions found, each with its evidence count, when the
  search happened, and whether it was fresh or reused.
- On the contact: which rung is in use, how many remain, and — when a rung
  died — that it died, when, and what the next attempt will be.
- When a ladder is exhausted: a distinct, visible outcome that reads as "no
  further address to try", not as a generic failure.
- Across the pipeline: how many prospects are alive on rung one, how many
  advanced, how many are exhausted. This is the number that says whether the
  feature earns its risk.

## Bounds

The feature deliberately spends deliverability. It therefore needs limits that
are visible and adjustable, not implicit:

- A ceiling on how many rungs a single contact may cost.
- A ceiling on advances per company and per sending mailbox per day, separate
  from the existing daily send caps, so a bad convention cannot spend a day's
  reputation in an hour.
- A rate at which explicit delivery failures should stop the ladder feature
  entirely rather than continue — a circuit breaker whose threshold the operator
  sets.
- Interaction with the emergency pause: an advance is a send and must obey it.

## Interactions to resolve

Existing behaviour this collides with, each needing an answer before build:

- **Cross-campaign cooldown and contact minimum delay.** A re-addressed message
  goes to the same person. Does the ladder advance respect delays designed to
  protect that person, or is it exempt because nothing reached them?
- **The tie refusal.** If the ladder subsumes it, the current manual-review
  dead-end should be removed rather than left as a second path.
- **Employer moves.** An advance must be invalid if the contact's employment
  changed since the address was generated; the existing employment fencing is
  the natural place for that.
- **Review queue.** A re-addressed message is not new content. Whether it
  re-enters review is a decision about how much the operator wants to see.
- **The confidence scale versus demotion.** Confidence today is a fixed function
  of sample count — six samples score the same forever. A demoted convention
  still displaying its original score misleads whoever reads the audit trail,
  while recomputing the score would retroactively change addresses already
  accepted and possibly already sent. The likely direction is to keep public
  sample evidence and delivery outcome evidence as **two visible quantities**
  rather than merging them into one number, because merging is where that
  retroactivity decision gets made silently.
- **What the dead-address suppression blocks.** A bounced address is suppressed
  permanently and across campaigns, which is right for the contact who bounced.
  But that address may belong to a real person — the wrong-recipient cost
  accepted above — and a genuine colleague of that name resolved later would be
  blocked forever by a suppression earned by somebody else's failed guess.
  Whether suppression keys on the address alone or on the address together with
  the identity it was guessed for is an open interaction, not a detail.
- **The single accepted address per contact.** A ladder implies the accepted
  address changes over time; the audit trail should show the sequence, not just
  the last one.

## Decisions taken

**1. May a rung be built from an unevidenced convention? Never.** Not even
behind a setting. The setting the alternative asked for already exists in a
better form: an operator who believes they know the address accepts it by hand,
which is evidenced by a human rather than by nobody. Building a second, weaker
version of that — one where the machine picks the guess — would add the risk
without adding the capability.

**2. Advancing is offered, not automatic.** This is settled by an invariant the
product already enforces rather than by preference: no first send may be
system-originated (`SPEC.md` §23, note of 2026-08-16). A re-addressed step-zero
message is a first message — the prospect received nothing — so an automatic
advance would be the system originating one. Therefore ties are safe to subsume
into the ladder, and the tie refusal goes.

"Offered" is drawn at approval, not at generation. An advance queues the
re-addressed message and it appears in the review queue; the operator's approval
is what sends it. That is the same line enrolment already draws when it queues
step zero without sending it.

**3. An advance respects every send-policy gate, unchanged.** Working hours, the
per-mailbox pacing delay, the per-contact minimum delay, the cross-campaign
cooldown, the daily caps, the emergency pause, suppression. No exemption is
added for the ladder. Two reasons: an exemption is how a safety layer starts
eroding, and the delays that look exempt-worthy are not — the cross-campaign
cooldown protects an inbox that a _different_ campaign may have reached
successfully, which the dead address says nothing about. The cost is that a
second rung usually leaves a day after the first, which is also a rate limit
worth having.

**4. The bounds.** Three rungs per contact, counted as addresses attempted, not
as advances. Two advances per company per day. A circuit breaker on the share of
attempted sends that produced an explicit delivery failure: 30% over a rolling
thirty days, ignored below 20 attempted sends, because one failure out of one
send is 100% and means nothing. Every one of these is an operator setting with
those values as defaults, shown next to the measurement it is compared against.

The per-company cap is what makes the feedback loop below useful rather than
decorative: at two advances a day, a convention reaches the two-distinct-people
demotion threshold before a third contact at that company is offered it.

**A bound pauses; it never condemns.** Recorded because the first build got this
wrong. Every bound above is a number the operator sets, so when one stops an
advance the enrollment is parked at the step that bounced — non-terminal, no
schedule, visible — and raising the bound and resolving the company again
promotes the address that is still there. Ending the prospect instead made the
per-company cap, whose entire purpose is pacing, lose the third bounce of the day
at one company as permanently as an exhausted ladder, with nothing in the product
able to bring them back. Only facts no setting changes are terminal: nothing left
to try, every remaining address suppressed, an earlier message never reported
undelivered, an employer that moved, a sequence somebody ended, or the feature
switched off.

**Not built, deliberately: a separate ceiling on advances per sending mailbox
per day.** The direction asked for one "so a bad convention cannot spend a day's
reputation in an hour". Under decision 2 an advance originates no send, so the
thing to bound is the sends the operator then approves — and those are already
bounded by the per-mailbox daily cap and the per-mailbox pacing delay, which are
exactly this ceiling under their existing names. A second, weaker copy of a live
bound is a liability, not a limit.

**5. A re-addressed message re-enters the review queue.** Forced by decision 2,
and free: the operator has to approve it for it to go at all.

**6. Demotion.** A convention is demoted at a company when it has been proven
dead for **at least two distinct people** and those failures are **at least half
of that convention's attempts at that company**. Both thresholds are settings.
The second is the confound guard the direction asks for: at a company where a
third of the discovered contacts have already left, a correct convention fails
three times out of ten and is not demoted; a wrong convention fails on
essentially everything and is.

Demotion reorders and never rescores. A demoted convention keeps the confidence
its public samples earned, and carries its delivery record beside it as a second
quantity, exactly as the _confidence scale versus demotion_ interaction
concluded. Nothing is retroactively rewritten.

**7. A demotion re-ranks a contact only if nothing has been written for them
yet** — no outbound message at all, not merely none sent. This is narrower than
the direction permits, on purpose. A contact who already has a generated message
is pinned to the old address by that message, and silently accepting a different
address would leave the send policy refusing that message for a reason the
operator never asked about. Those contacts keep their address and their review
card says the convention has since been demoted, which is a decision the operator
can act on instead of a state they have to discover.

### Two rules the questions did not ask for

**An advance requires that every attempted send on the enrollment was proven
dead.** This is the operational form of "a person whose send produced no
delivery failure must never be re-addressed". A message that was attempted and
is not proven dead — including one whose delivery is merely uncertain — blocks
the advance permanently, because the prospect may hold it. A proposal that was
never attempted, or was rejected in review, blocks nothing. The practical
consequence is that the ladder is almost entirely a step-zero feature, which is
the right shape: a hard bounce at step two on an address that carried step zero
and step one says the person left, not that the convention was wrong, and the
ladder must not answer a question about employment.

**Suppression stays keyed on the address alone.** The interaction is real — a
genuine colleague whose real address is the one somebody else's failed guess
suppressed is blocked forever — and the answer is still to leave the strongest
pre-send gate unconditional. What changes instead is that a suppressed address
is never offered as a rung, and says so, so the operator sees a blocked rung
rather than a silent refusal at send time. Un-blocking it is the existing
suppression-removal flow, which already demands a justification and an explicit
override for a hard-bounce entry.

**Sibling enrollments are not advanced.** If the same contact is enrolled in a
second campaign on the dead address, that enrollment stops on the suppression as
it does today rather than advancing. It is the same conflation this design exists
to remove, and it is left in place because the cross-campaign cooldown makes it
rare and because advancing two enrollments from one bounce doubles the send the
operator was offered once.

### Decided during review, after the first implementation

**A demotion is written down, not recomputed.** The first implementation derived
"is this convention demoted?" from a live ratio over every attempt ever made at
the domain. A live ratio falls: two deaths in four attempts demotes a
convention, and four later attempts that reported nothing put it back under the
threshold and restored it. That is silence confirming a convention — the one
thing "outcome evidence can demote and never confirm" forbids. The verdict is
now latched per `(mail domain, convention)` the moment the threshold is met,
with the counts that produced it, and reading a domain's demoted conventions is
the latch unioned with the live ratio. The alternatives were a thirty-day window
matching the circuit breaker, and amending this document to accept the dilution;
both were rejected because the demotion only reorders — the cost of a latch that
ages badly is one convention sitting at the back of one company's ladder, and
the cost of dilution is an address delivery discredited being offered first
again.

**A parked prospect becomes visible, not automatic.** A bound the operator can
raise parks the enrollment, and nothing was showing them. The review queue now
lists every enrollment in `manual_review` with no message written and no command
queued to write one — which also catches any other silent failure to queue work,
not only the ladder's. Automatic resumption when the bound clears was rejected:
an advance is a send, and "offered, not automatic" is the invariant the whole
feature rests on. Raising the cap and re-resolving the prospect is the operator's
move, from the page the list links to.

**An address proven dead cannot be accepted by hand.** Accepting an address
manually is the operator's strongest move and deliberately overrides confidence,
MX and evidence. It does not override a delivery failure or a suppression, both
of which now refuse with a sentence naming what stands in the way. A manually
accepted address is also re-ranked like every other, rather than taking the
schema's default rung and sharing it.

**A dead address is recorded whatever the sequence did.** The suppression and
the dead-marking used to sit inside the check that skipped enrollments already
ended, so a definite refusal arriving after a reply or a manual stop wrote
nothing down and left the address sendable in every future campaign. Both are
facts about the address; only the decision about the enrollment belongs behind
that check.

**"No signal" excludes anything that answered.** The measure exists to test
whether the domains being written to report undeliverable addresses at all. As
"attempts minus explicit failures" it was the arithmetic complement of the
failure rate and measured nothing else. Sends that produced a reply, an
out-of-office or an autoresponder are counted separately, as the only positive
delivery evidence this product ever receives.

**A demotion is reported against the company it happened at.** The
installation-wide view pooled every domain's ratio into one verdict, which is a
number no decision is ever taken on. Conventions are now grouped per domain and
the view names the companies where each is demoted.

## How we would know it works

Not "it was built", but:

- The share of discovered contacts holding a usable address, before and after.
- The share of sends producing an explicit delivery failure, and separately the
  share producing no signal at all — the number that tests the operator's
  contested assumption.
- The same failure and no-signal counts broken down **per convention**, which is
  the whole data requirement of the feedback loop above.
- The share of prospects reached on rung two or later: the feature's actual
  yield, and the only justification for the deliverability it spends.
- Bounce rate on the sending mailbox over time, which is the cost side of the
  same ledger and must be read next to the yield, never alone. This number needs
  a baseline before the ladder exists: the first sends made under today's
  single-address behaviour are what the circuit breaker's threshold should be set
  against. Without that baseline the threshold is a number invented in a
  settings field.

## Non-goals

- SMTP recipient probing. Already rejected in `SPEC.md` §9 and unchanged here.
- Paid enrichment or data providers. Explicitly refused by the operator; the
  `EmailEnrichmentProvider` seam stays unused.
- Guessing an address with no evidence at rung one. The ladder changes what
  happens after a failure, never what happens before the first attempt.
- Verifying an address without sending. Out of scope by the same reasoning that
  rejects probing.
- Changing how the convention is discovered. The search, its prompt and its
  reuse are unchanged by this spec.
- Fixing the command queue's classification of a reusing resolution as an AI
  turn. That defect — which makes ten contacts take ten minutes for one search —
  is what makes a company-level action usable at all, but it is a bug in the
  queue and is fixed independently of whether this design is ever approved.

  Note of 2026-08-18: it was fixed as part of this work, because the
  company-level action is unusable without it, and the fix turned out to be a
  deletion rather than an addition. The queue no longer predicts whether a
  command will spend a turn on the operator's ChatGPT window; it observes
  whether one was spent, by asking whether the command wrote an `agent_runs`
  row. That answers the same question for a resolution that reused a recorded
  search, for account research that reused a fresh snapshot, and for a
  deterministic generation, without a per-task table of guesses.
