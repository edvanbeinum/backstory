import { KEY, readNamespaced, storePath, writeNamespaced } from "./store";

/**
 * Thread → commit pins.
 *
 * A pin says "this review comment was addressed by this commit", replacing
 * the file-level guess for good. Stored server-side rather than in
 * localStorage so the dev server, the standalone server and the installed
 * app window all agree — and outside the repo, so the read-only promise
 * holds: differ never writes to a checkout.
 *
 * Shape: { "owner/repo#26": { "<threadId>": "<sha>" } }
 */

const NAME = "links";
const SHA = /^[0-9a-f]{7,40}$/;

const isSha = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);

export function prKey(
  owner: string | null,
  name: string | null,
  prNumber: number,
): string | null {
  if (!owner || !name) return null;
  return `${owner}/${name}#${prNumber}`;
}

export async function getLinks(key: string): Promise<Record<string, string>> {
  const store = await readNamespaced(NAME, isSha);
  return store[key] ?? {};
}

/** Pin a thread to a commit, or unpin it when `sha` is null. */
export async function setLink(
  key: string,
  threadId: string,
  sha: string | null,
): Promise<Record<string, string>> {
  if (!KEY.test(threadId)) throw new Error("Invalid thread id");
  if (sha !== null && !isSha(sha)) throw new Error("Invalid commit sha");

  const store = await readNamespaced(NAME, isSha);
  const forPr = { ...(store[key] ?? {}) };

  if (sha === null) delete forPr[threadId];
  else forPr[threadId] = sha;

  store[key] = forPr;
  await writeNamespaced(NAME, store);
  return forPr;
}

export const LINKS_FILE = storePath(NAME);
