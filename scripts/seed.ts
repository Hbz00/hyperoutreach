import { config } from "dotenv";
import postgres from "postgres";

import { sanitizeDatabaseError } from "../src/lib/db/sanitize-error";

config({ path: ".env.local" });
config({ path: ".env" });

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach";
const client = postgres(databaseUrl, { max: 1 });

try {
  await client`
    insert into mailbox_connections (
      provider, email, normalized_email, status, settings
    ) values (
      'mock', 'operator@example.com', 'operator@example.com', 'available',
      '{"dailyCap":50,"minimumDelaySeconds":60}'::jsonb
    )
    on conflict (provider, normalized_email) do update
      set status = 'available', updated_at = now()
  `;
  console.log("Local mock mailbox seed applied.");
} catch (error) {
  console.error(
    `Database seed failed: ${sanitizeDatabaseError(error, [databaseUrl])}`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
