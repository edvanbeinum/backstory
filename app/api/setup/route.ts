import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { setupChecksFresh } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The setup checklist's rows: git, GitHub, Claude Code, data models and notes to your agent. */
export async function GET() {
  try {
    return NextResponse.json(
      { rows: await setupChecksFresh() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
