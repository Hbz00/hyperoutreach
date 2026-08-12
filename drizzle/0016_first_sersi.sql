WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY contact_id
      ORDER BY confidence DESC, verified_at DESC NULLS LAST, created_at DESC, id
    ) AS accepted_rank
  FROM email_candidates
  WHERE status = 'accepted'
)
UPDATE email_candidates AS candidate
SET status = 'candidate'
FROM ranked
WHERE candidate.id = ranked.id AND ranked.accepted_rank > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "email_candidates_one_accepted_per_contact_unique" ON "email_candidates" USING btree ("contact_id") WHERE "email_candidates"."status" = 'accepted';
