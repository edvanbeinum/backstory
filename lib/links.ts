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
 * Each pin carries a patch-id as well as a sha. A rebase gives every commit
 * a new sha but leaves its patch-id — a hash of the diff alone — untouched,
 * so a stale pin can be re-matched instead of thrown away. See healLinks().
 *
 * Shape: { "owner/repo#26": { "<threadId>": { sha, patchId } } }
 */

const NAME = "links";
const SHA = /^[0-9a-f]{7,40}$/;
const PATCH_ID = /^[0-9a-f]{40}$/;

export interface Pin {
  sha: string;
  /** Diff hash that survives rebases; null when git couldn't produce one */
  patchId: string | null;
}

/**
 * Accepts the original bare-string form as well as the current object form,
 * so pins made before patch-ids existed keep working. They heal into the new
 * shape the next time they're written.
 */
function isPin(value: unknown): value is Pin {
  if (typeof value === "string") return SHA.test(value);
  if (!value || typeof value !== "object") return false;
  const pin = value as Pin;
  return (
    typeof pin.sha === "string" &&
    SHA.test(pin.sha) &&
    (pin.patchId === null ||
      (typeof pin.patchId === "string" && PATCH_ID.test(pin.patchId)))
  );
}

function normalize(value: Pin | string): Pin {
  return typeof value === "string" ? { sha: value, patchId: null } : value;
}

export function prKey(
  owner: string | null,
  name: string | null,
  prNumber: number,
): string | null {
  if (!owner || !name) return null;
  return `${owner}/${name}#${prNumber}`;
}

export async function getLinks(key: string): Promise<Record<string, Pin>> {
  const store = await readNamespaced<Pin | string>(NAME, isPin);
  const entries = store[key] ?? {};
  return Object.fromEntries(
    Object.entries(entries).map(([threadId, value]) => [
      threadId,
      normalize(value),
    ]),
  );
}

/** Pin a thread to a commit, or unpin it when `sha` is null. */
export async function setLink(
  key: string,
  threadId: string,
  sha: string | null,
  patchId: string | null = null,
): Promise<Record<string, Pin>> {
  if (!KEY.test(threadId)) throw new Error("Invalid thread id");
  if (sha !== null && !SHA.test(sha)) throw new Error("Invalid commit sha");
  if (patchId !== null && !PATCH_ID.test(patchId)) {
    throw new Error("Invalid patch id");
  }

  const store = await readNamespaced<Pin | string>(NAME, isPin);
  const forPr = { ...(store[key] ?? {}) };

  if (sha === null) delete forPr[threadId];
  else forPr[threadId] = { sha, patchId };

  store[key] = forPr;
  await writeNamespaced(NAME, store);

  return Object.fromEntries(
    Object.entries(forPr).map(([id, value]) => [id, normalize(value)]),
  );
}

/**
 * Apply several pin updates in ONE read-modify-write.
 *
 * Not a loop over setLink: each of those rereads and rewrites the whole
 * file, so running them concurrently makes the last writer win and silently
 * drop the others. Used for both rebase healing and patch-id backfill, which
 * are inherently batch operations.
 */
export async function updateLinks(
  key: string,
  updates: Record<string, Pin>,
): Promise<void> {
  if (Object.keys(updates).length === 0) return;

  const store = await readNamespaced<Pin | string>(NAME, isPin);
  const forPr = { ...(store[key] ?? {}) };

  for (const [threadId, pin] of Object.entries(updates)) {
    // Only update pins that still exist — never resurrect an unpinned thread.
    if (!forPr[threadId]) continue;
    forPr[threadId] = pin;
  }

  store[key] = forPr;
  await writeNamespaced(NAME, store);
}

export const LINKS_FILE = storePath(NAME);
