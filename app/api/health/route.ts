import { NextResponse } from "next/server";

import { BUILD_ID, VERSION } from "@/lib/build";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Identifies a running Backstory to the CLI and the Mac app, which use it to
 * tell Backstory from some other app on the port, and tells the window which
 * build is serving, so one left open across a rebuild knows to reload.
 */
export async function GET() {
  return NextResponse.json(
    { app: "backstory", ok: true, build: BUILD_ID, version: VERSION },
    { headers: { "Cache-Control": "no-store" } },
  );
}
