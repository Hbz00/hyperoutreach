import { NextResponse } from "next/server";

import journal from "../../../../drizzle/meta/_journal.json";
import { getSqlClient } from "@/lib/db/client";
import { checkDatabaseHealth } from "@/lib/db/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const health = await checkDatabaseHealth(
    async () => {
      await getSqlClient()`select 1`;
    },
    {
      expectedMigrations: journal.entries.length,
      countAppliedMigrations: async () => {
        const [row] = await getSqlClient()<{ count: number }[]>`
          select count(*)::int as count from drizzle.__drizzle_migrations
        `;
        return row?.count ?? 0;
      },
    },
  );

  return NextResponse.json(health, {
    status: health.status === "ok" ? 200 : 503,
  });
}
