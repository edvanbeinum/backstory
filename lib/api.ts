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
