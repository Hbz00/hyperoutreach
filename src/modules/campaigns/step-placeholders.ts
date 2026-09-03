/**
 * The copy the campaign form suggests for each sequence step.
 *
 * Shown as placeholders rather than filled in as values, and the distinction is
 * the whole point. These were `defaultValue`s, and a real run published them
 * untouched: a first email that read "I am speaking with Directeur Général de
 * l'Experience Client Chez FedEx Express France leaders at companies like FedEx
 * Express France", followed by two byte-identical follow-ups three days apart.
 *
 * A default on an optional step also inverts what the form promises. It says
 * "leave subject and body empty to skip them" while pre-filling both, so
 * skipping a follow-up meant deleting two boxes — opt-out by deletion, which is
 * how a sequence came to repeat itself. Empty boxes cannot be published by
 * accident: step one is required, and a step with neither subject nor body is
 * dropped before the sequence is built.
 *
 * Held to three rules by `tests/unit/campaign-step-placeholders.test.ts`: no
 * two steps share copy, none inlines `{{job_title}}`, and none names an
 * agent-written field the unchecked AI boxes would refuse to declare.
 */
export const CAMPAIGN_STEP_PLACEHOLDERS = [
  {
    subject: "A question for {{company}}",
    // No `{{job_title}}`. That field holds whatever the discovery agent
    // reported — a business-card title at best, a profile headline carrying its
    // own employer at worst — and neither is a sentence fragment. It remains a
    // legal variable for an operator who wants it; it is no longer suggested.
    body: "Hello {{first_name}},\n\nI am talking to a few people at {{company}} about how they handle [the problem you are exploring]. Would you be open to a short conversation?",
  },
  {
    subject: "Following up, {{first_name}}",
    body: "Hello {{first_name}},\n\nBringing my note back to the top of your inbox, in case it arrived at a bad moment.",
  },
  {
    subject: "One last note, {{first_name}}",
    body: "Hello {{first_name}},\n\nI will stop here. If this is not the right time, a one-line reply saying so is genuinely useful.",
  },
] as const satisfies readonly { subject: string; body: string }[];
