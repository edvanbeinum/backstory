import { NextResponse } from "next/server";

import { aiProvider } from "@/lib/ai/provider";
import { errorResponse } from "@/lib/api";
import { providerStatusFresh } from "@/lib/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the AI provider is installed and signed in, for the Claude Code gate. */
export async function GET() {
  try {
    return NextResponse.json(
      { status: await providerStatusFresh(), provider: aiProvider().name },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
