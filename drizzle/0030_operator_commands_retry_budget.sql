-- Four attempts, so the third backoff step (15 minutes) is reachable.
-- At three the ladder ended after the second wait and a command died six
-- minutes into any outage; the outage this transport has is the operator's
-- ChatGPT desktop app closed, updating, or asleep with the laptop.
ALTER TABLE "operator_commands" ALTER COLUMN "max_attempts" SET DEFAULT 4;
