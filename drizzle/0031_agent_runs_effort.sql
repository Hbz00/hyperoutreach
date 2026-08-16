-- Both lanes run the same model, so the model alone cannot tell a ten-minute
-- web-capable research turn from a two-minute fast one. Nullable and never
-- backfilled: the effort of a past run is not recoverable, and a guess would
-- be worse than the blank.
ALTER TABLE "agent_runs" ADD COLUMN "effort" text;
