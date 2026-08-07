import { KEY, readNamespaced, storePath, writeNamespaced } from "./store";

/**
 * How a review comment was handled.
 *
 * Linking is deliberate: differ no longer guesses which commit answers a
 * comment. A guess always found *something*, so nothing ever read as
 * outstanding and the comment list couldn't work as a checklist. Asserting
 * the link is also the moment you actually check the change against the
 * comment, which is the point of the exercise.
 *
 * Two ways to handle one:
 *   - `commit` — this commit addresses it. Carries a patch-id so the link
 *     survives a rebase (see healing in the session route).
 *   - `ack` — no code change needed; it just wants a reply.
 *
 * Shape: { "owner/repo#26": { "<threadId>": {kind:"commit",sha,patchId} } }
 */

const NAME = "links";
const SHA = /^[0-9a-f]{7,40}$/;
const PATCH_ID = /^[0-9a-f]{40}$/;

export type LinkRecord =
  | { kind: "commit"; sha: string; patchId: string | null }
  | { kind: "ack" };

/** The stored forms, current and historical. */
type StoredLink = LinkRecord | { sha: string; patchId?: string | null } | string;

/**
 * Accepts every shape this file has ever held: a bare sha string, the
 * `{sha, patchId}` object, and the current tagged union. Older entries are
 * normalised on read and rewritten in the new shape whenever they're touched.
 */
function isStoredLink(value: unknown): value is StoredLink {
  if (typeof value === "string") return SHA.test(value);
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (record.kind === "ack") return true;
  if (typeof record.sha !== "string" || !SHA.test(record.sha)) return false;
  return (
    record.patchId === null ||
    record.patchId === undefined ||
    (typeof record.patchId === "string" && PATCH_ID.test(record.patchId))
  );
}

function normalize(value: StoredLink): LinkRecord {
  if (typeof value === "string") {
    return { kind: "commit", sha: value, patchId: null };
  }
  if ("kind" in value && value.kind === "ack") return { kind: "ack" };
  const record = value as { sha: string; patchId?: string | null };
  return { kind: "commit", sha: record.sha, patchId: record.patchId ?? null };
}

export function prKey(
  owner: string | null,
  name: string | null,
  prNumber: number,
): string | null {
  if (!owner || !name) return null;
  return `${owner}/${name}#${prNumber}`;
}

export async function getLinks(
  key: string,
): Promise<Record<string, LinkRecord>> {
  const store = await readNamespaced<StoredLink>(NAME, isStoredLink);
  const entries = store[key] ?? {};
  return Object.fromEntries(
    Object.entries(entries).map(([threadId, value]) => [
      threadId,
      normalize(value),
    ]),
  );
}

/** Record how a comment was handled, or clear it with `null`. */
export async function setLink(
  key: string,
  threadId: string,
  link: LinkRecord | null,
): Promise<Record<string, LinkRecord>> {
  if (!KEY.test(threadId)) throw new Error("Invalid thread id");
  if (link?.kind === "commit") {
    if (!SHA.test(link.sha)) throw new Error("Invalid commit sha");
    if (link.patchId !== null && !PATCH_ID.test(link.patchId)) {
      throw new Error("Invalid patch id");
    }
  }

  const store = await readNamespaced<StoredLink>(NAME, isStoredLink);
  const forPr = { ...(store[key] ?? {}) };

  if (link === null) delete forPr[threadId];
  else forPr[threadId] = link;

  store[key] = forPr;
  await writeNamespaced(NAME, store);

  return Object.fromEntries(
    Object.entries(forPr).map(([id, value]) => [id, normalize(value)]),
  );
}

/**
 * Apply several updates in ONE read-modify-write.
 *
 * Not a loop over setLink: each of those rereads and rewrites the whole file,
 * so running them concurrently makes the last writer win and silently drop
 * the others. Used for rebase healing and patch-id backfill, which are
 * inherently batch operations.
 */
export async function updateLinks(
  key: string,
  updates: Record<string, LinkRecord>,
): Promise<void> {
  if (Object.keys(updates).length === 0) return;

  const store = await readNamespaced<StoredLink>(NAME, isStoredLink);
  const forPr = { ...(store[key] ?? {}) };

  for (const [threadId, link] of Object.entries(updates)) {
    // Only update entries that still exist — never resurrect a cleared one.
    if (!forPr[threadId]) continue;
    forPr[threadId] = link;
  }

  store[key] = forPr;
  await writeNamespaced(NAME, store);
}

export const LINKS_FILE = storePath(NAME);
