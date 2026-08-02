import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Identifies a running differ to the CLI launcher, which uses it to decide
 * "reuse this server" vs "that port is some other app — pick another".
 */
export async function GET() {
  return NextResponse.json(
    { app: "differ", ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
