import { NextResponse } from "next/server";

import { getSqlClient } from "@/lib/db/client";
import { checkDatabaseHealth } from "@/lib/db/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const health = await checkDatabaseHealth(async () => {
    await getSqlClient()`select 1`;
  });

  return NextResponse.json(health, {
    status: health.status === "ok" ? 200 : 503,
  });
}
