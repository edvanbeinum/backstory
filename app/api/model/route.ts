import { promises as fs } from "node:fs";

import { NextResponse } from "next/server";

import { crossSite, errorResponse } from "@/lib/api";
import { resolveRepo } from "@/lib/git";
import { localModelFile, MODEL_DSL, showFile } from "@/lib/model";
import {
  draftStatus,
  startDraft,
  type ModelSourceResponse,
} from "@/lib/models/draft";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The repo's C4 model at HEAD, and drafting a local one. GET says where the
 * model comes from and how a draft is going; POST starts a draft, or with
 * `redraft=1` replaces the local model. The strip polls GET while one runs.
 */

async function resolve(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  if (!repoPath) {
    return {
      error: NextResponse.json<ApiError>(
        { error: "`repo` is required.", kind: "missing-path" },
        { status: 400 },
      ),
    };
  }
  const repo = await resolveRepo(repoPath);
  return { root: repo.root, searchParams };
}

async function sourceOf(root: string): Promise<ModelSourceResponse> {
  const job = await draftStatus(root);
  if ((await showFile(root, "HEAD", MODEL_DSL)) !== null)
    return { source: "committed", file: null, job };
  const file = await localModelFile(root);
  const local = await fs.access(file).then(
    () => true,
    () => false,
  );
  return { source: local ? "local" : "none", file: local ? file : null, job };
}

export async function GET(request: Request) {
  try {
    const r = await resolve(request);
    if ("error" in r) return r.error;
    return NextResponse.json(await sourceOf(r.root), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  // A draft costs money and sends code to Claude: only differ's own page asks.
  const refused = crossSite(request);
  if (refused) return refused;
  try {
    const r = await resolve(request);
    if ("error" in r) return r.error;
    const started = await startDraft(r.root, {
      redraft: r.searchParams.get("redraft") === "1",
    });
    if (started.status === "refused") {
      return NextResponse.json<ApiError>(
        {
          error:
            started.reason === "committed"
              ? "This repo commits its own model, so there's nothing to draft."
              : "There's already a local model. Redraft to replace it.",
          kind: "internal",
        },
        { status: 409 },
      );
    }
    return NextResponse.json(await sourceOf(r.root));
  } catch (err) {
    return errorResponse(err);
  }
}
