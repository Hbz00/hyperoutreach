# The address ladder

[← Back to the README](../README.md)

A contact holds an **ordered ladder** of the addresses the evidence named for
them, not a single verdict. Rung one is the best-evidenced convention; later rungs
are the others, ordered by evidence and then by how common the form is — never
alphabetically, which is what the previous tiebreak amounted to. A contact whose
company showed one convention has a one-rung ladder, and that is a complete state,
not a degraded one.

Two conventions evidenced exactly as well as each other used to be refused
outright, because picking one was a coin toss whose losing side was a bounce, a
permanent suppression and a prospect spent for nothing. Under a ladder the loser
of a tie is simply rung two, so the pair resolves — and the review card says the
order was arbitrary, because approving the message is now the only human check on
it.

**A proven-dead address advances the ladder instead of ending the person.** A hard
bounce — an explicit delivery-status report, or a definite SMTP recipient refusal
— establishes two separate facts, and the product used to conflate them: the
address is dead, the person is not. The suppression written for the dead address
stays permanent and keyed on the address alone; what changes is that the next
evidenced address is accepted, the enrollment returns to the step that bounced
without consuming it, and the re-addressed message is queued for review. It is
**offered, never automatic**: a re-addressed first message is still a first
message, and no first send in this product may be system-originated. Follow-up
timing counts from the most recent attempt that was not proven dead — never from
"the one that landed", which is a fact this product cannot establish.

Only a hard failure advances anything. Soft failures, greylisting and quota
refusals stay on the existing retry path. A report naming a different recipient
than the one addressed advances nothing. Silence is never a signal in either
direction: it is not read as delivery and not read as failure.

Six rules bound what may advance:

- Every _attempted_ message on the enrollment must be proven dead. One that was
  attempted and is not — including one whose delivery is merely uncertain — blocks
  the advance permanently, because the prospect may be holding it. This makes the
  ladder almost entirely a step-zero feature, which is the right shape: a hard
  bounce at step two on an address that carried step zero says the person left,
  not that the convention was wrong.
- A sequence somebody _ended_ is never resurrected. The one terminal state that
  may advance is a sequence that completed by running out of steps, which is where
  a one-step campaign lives.
- One death advances one ladder. A contact enrolled in a second campaign can have
  both messages in flight when the first failure comes back; the second one is
  recorded dead — the breaker counts it — and then stops on the suppression exactly
  as it did before the ladder existed, because advancing it too would offer a
  second copy at the same new address to the same human.
- The contact's employment must not have changed since the dead message.
- A suppressed address is never offered as a rung, and says so. A suppression is
  permanent and keyed on the address alone, so a colleague's failed guess can own
  the address this person's convention produces; un-blocking it is the existing
  suppression-removal flow, which already demands a justification and an explicit
  override for a hard-bounce entry.
- The bounds in `/settings`: how many addresses one contact may cost (three by
  default, counted as addresses attempted), how many advances one company may
  produce in a day (two), and a circuit breaker on the share of attempted sends
  producing an explicit delivery failure (30% over thirty days, ignored below
  twenty attempted sends — one failure out of one send is 100% and means nothing).
  Each is shown beside the number it is judged against. There is deliberately no
  separate per-mailbox advance ceiling: an advance originates no send, and the
  sends the operator then approves are already bounded by the per-mailbox daily cap
  and pacing delay.

An exhausted ladder reaches the same terminal state a bounce reaches today. The
distinct outcome the operator asked for lives where it belongs — on the contact's
address, as `ladder_exhausted` — rather than on the sequence, which honestly
bounced.

**A bound is a pause, not a verdict.** Only facts no setting changes end the
prospect: nothing left to try, every remaining address suppressed, an earlier
message that was never reported undelivered, an employer that moved, a sequence
somebody ended, or the feature switched off. When a _raisable_ bound stops an
advance — the rung ceiling, the per-company daily cap, an open circuit breaker —
the enrollment is parked in manual review at the step that bounced, with no
schedule, and the contact reads `ladder_limit_reached`. Raising the bound and
resolving the company again promotes the address that is still there, because a
dead one is never re-accepted and the next rung is simply the best that is left.
Ending the prospect instead would have made the per-company cap — a pacing device
— lose the third bounce of the day at one company as permanently as an exhausted
ladder, with nothing able to bring them back.

The one refusal that is not a bound has its own sentence:
`ladder_earlier_send_unconfirmed`, for a person who may be holding a message
already. Nothing the operator changes alters that answer, so it must not read as
an invitation to try.

**Delivery outcomes demote a convention and can never confirm one.** A convention
proven dead for at least two distinct people at one company, and for at least half
the people it was attempted on there, is ordered last for that company's contacts.
The share is not decoration: a hard bounce cannot tell a wrong address shape from a
person who has left, so at a company whose contact data is stale a _correct_
convention fails a few times out of many — and a rule counting failures alone would
demote true conventions hardest exactly where discovery is weakest. Demotion
reorders and never rescores: public-sample confidence and the delivery record stay
two visible quantities, side by side on the contact page and on `/outbound`, because
merging them is where a retroactive rescoring of addresses already sent would get
made silently. It also never removes — a contact whose only rung uses the demoted
convention keeps it — and it re-ranks only contacts with no outbound message at
all, so an address a generated message is already pinned to is never moved under
it.

A ladder belongs to **one company**. A contact who changes employer keeps the
addresses evidenced at the old one, so their rows can span two domains — and both
the ordering and the choice of the next rung are scoped to the domain the dead
message was sent at, so one employer's verdict never reorders another's addresses
and a former employer's address is never offered as the next thing to try.

The daily advance cap is counted per candidate mail domain over the preceding
24 hours, despite the retained setting name
`address_ladder_max_advances_per_account_per_day`; it does not follow a contact
to their current account or combine that account's different mail domains.

The verdict is **written down when it is reached, not recomputed on every read**.
A live ratio falls: two deaths in four attempts demotes a convention, and four
later attempts that reported nothing would put it back under the threshold and
restore it — silence confirming a convention, which delivery evidence here is
never allowed to do. The demotion is latched per mail domain and convention, with
the counts that produced it, and nothing the delivery record does can lift it.

**Only an operator can**, and only in writing. A hard bounce cannot tell a wrong
convention from a person who has left; the two-people floor narrows that and does
not close it, so a company that lost several people in a quarter can discredit a
convention that works — and the record will never say so, because the record is
the thing that is wrong. Restoring one is as demanding as removing a suppression:
grounds in writing, an explicit statement that the company does use the
convention, and the actor on the audit row. The verdict is not deleted but
stamped, and the stamp is the point the record restarts from, and the ladders the
demotion reordered are put back with it: a rung is stored and the choice of the
next address reads it, so lifting the verdict alone would change nothing for the
contacts the verdict had already moved. Being right restores the convention;
being wrong costs the next failures rather than nothing, because two more deaths
since the restore demote it again — on the evidence gathered since, never on the
evidence excused. That decision is taken while holding a lock on the row, and the
evidence is counted there too: the bounce path takes no lock a restore can wait
on, so a verdict reached a moment before one commits must never be allowed to
answer it.

`/outbound` reports the yield beside the cost: how many prospects are alive on rung
one, how many are alive on a later rung and how many of those a death put there,
how many have no further address to
try, how many were stopped by a bound, and — per convention — how many people were
attempted, how many were proven dead, and at which companies each convention is
demoted.

Every send falls in exactly one of three buckets: **proven not to exist**,
**something came back that was not a failure**, or **nothing came back**. The
middle one — a reply, an out-of-office, an autoresponder — is the only positive
delivery evidence this product ever receives, and it is kept out of the last one.
Counted as "attempts minus explicit failures", that last bucket was the arithmetic
complement of the failure rate and tested nothing, where the point of it is to
test whether the domains being written to report bad addresses back at all. A
temporary failure sits there too: it says the address may be wrong, never that it
is. The per-convention table counts _people no failure was reported for_, which is
a weaker statement and is labelled as one — answering it per convention would mean
joining every candidate to its replies for a number the question does not need.

The review queue lists every prospect **parked with nothing to move them**: an
enrollment waiting on a decision with no message written, nothing queued to write
one, and no unclassified reply being reprocessed on its own. A raisable bound puts
prospects there deliberately, and any other silent failure to queue work lands
there too. They are never resumed automatically — an advance is a send, and no
first send in this product is system-originated — so the list links to the
prospect, where resolving the company again promotes whichever address is still
standing. Each row names the bound that is in the way, because three settings
produce the same `ladder_limit_reached` sentence and raising the wrong one
changes nothing.

Accepting an address **by hand** overrides confidence, MX and evidence, and
deliberately does not override delivery: an address a bounce has already proven
does not exist, or one the suppression list blocks, is refused with a sentence
naming what stands in the way. The lift is the existing suppression-removal flow.

Inbound reconciliation reuses the classification and agent-run identity already
persisted on unmatched or ambiguous replies. Repeated scans and later thread
rematches therefore do not rerun the classifier or create orphaned audit rows.
