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
  if (!response.ok) {
    const err = (await response.json().catch(() => null)) as ApiError | null;
    if (!err) throw new Error(`Backstory answered ${response.status}.`);
    throw new Error(err.detail ? `${err.error} ${err.detail}` : err.error);
  }
  return (await response.json()) as FetchResult;
}
