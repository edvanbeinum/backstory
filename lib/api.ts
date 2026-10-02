import { NextResponse } from "next/server";

import { RepoError } from "./git";
import type { ApiError } from "./types";

/** Turn any thrown value into the ApiError shape the UI knows how to render. */
export function errorResponse(err: unknown) {
  if (err instanceof RepoError) {
    return NextResponse.json<ApiError>(
      { error: err.message, kind: err.kind, detail: err.detail },
      { status: err.kind === "git" ? 500 : 400 },
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json<ApiError>(
    {
      error: "Something went wrong reading the repository.",
      detail: message,
      kind: "internal",
    },
    { status: 500 },
  );
}

/**
 * Refuse a request another website's page sent. differ listens on a fixed
 * local port, so any page the user visits can POST to it; a browser marks
 * such a request with Sec-Fetch-Site and Origin. Requests without them (the
 * CLI, curl) are the user's own.
 */
export function crossSite(request: Request): NextResponse | null {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const foreignOrigin = origin !== null && host !== null && new URL(origin).host !== host;
  if ((site && site !== "same-origin" && site !== "none") || foreignOrigin) {
    return NextResponse.json<ApiError>(
      { error: "Requests from other sites aren't accepted.", kind: "internal" },
      { status: 403 },
    );
  }
  return null;
}
