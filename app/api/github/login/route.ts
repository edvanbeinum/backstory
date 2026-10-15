import { NextResponse } from "next/server";

import { crossSite, errorResponse } from "@/lib/api";
import { clearGitHubCache, forgetGitHubToken } from "@/lib/github";
import {
  gitHubLoginState,
  resetGitHubLogin,
  startGitHubLogin,
} from "@/lib/githubLogin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** Where Connect GitHub has got to, for the setup checklist's poll. */
export async function GET() {
  return NextResponse.json(gitHubLoginState(), NO_STORE);
}

/** Connect GitHub: asks GitHub for a code and starts waiting for approval. */
export async function POST(request: Request) {
  const refused = crossSite(request);
  if (refused) return refused;
  try {
    const { started } = await startGitHubLogin();
    return NextResponse.json(started, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Disconnect GitHub: deletes the saved token. With none saved, does nothing. */
export async function DELETE(request: Request) {
  const refused = crossSite(request);
  if (refused) return refused;
  try {
    resetGitHubLogin();
    await forgetGitHubToken();
    clearGitHubCache();
    return NextResponse.json(gitHubLoginState(), NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
}
