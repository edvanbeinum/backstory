import type { FetchResult } from "@/lib/fetch";
import type { ApiError } from "@/lib/types";

/** Asks the server to fetch `branch` from origin, throwing git's message when it can't. */
export async function requestFetch(
  repo: string,
  branch: string,
  base: string | null,
): Promise<FetchResult> {
  const response = await fetch("/api/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, branch, base }),
  });
  const data = (await response.json()) as FetchResult | ApiError;
  if (!response.ok) {
    const err = data as ApiError;
    throw new Error(err.detail ? `${err.error} ${err.detail}` : err.error);
  }
  return data as FetchResult;
}
