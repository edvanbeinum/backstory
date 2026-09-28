import { NextResponse } from "next/server";

import { BUILD_ID } from "@/lib/build";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Identifies a running differ to the CLI launcher, which uses it to decide
 * "reuse this server" vs "that port is some other app — pick another" — and
 * tells the window which build is serving, so one left open across a rebuild
 * or upgrade knows to reload.
 */
export async function GET() {
  return NextResponse.json(
    { app: "differ", ok: true, build: BUILD_ID },
    { headers: { "Cache-Control": "no-store" } },
  );
}
