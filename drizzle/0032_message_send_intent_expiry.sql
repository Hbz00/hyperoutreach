-- A scheduled send needs two clocks, not one: when the lane may next try, and
-- when the intent gives up. `scheduled_at` moves forward on every re-check, so
-- it cannot also be the anchor the lifetime is measured from. Nullable and
-- never backfilled: no intent exists before this ships.
ALTER TABLE "messages" ADD COLUMN "send_intent_expires_at" timestamp with time zone;
