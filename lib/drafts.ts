import { KEY, readNamespaced, storePath, writeNamespaced } from "./store";

/**
 * Thread → draft reply text.
 *
 * Drafts are the one thing differ produces that can't be regenerated —
 * everything else is derived from git — so they outlive the component that
 * holds them. Previously a draft lived in React state and vanished on
 * reload, on collapsing the thread, and on switching commits.
 *
 * Stored next to the pins for the same reasons: shared across the dev
 * server, the standalone server and the app window, and never written into
 * the repo.
 *
 * Shape: { "owner/repo#26": { "<threadId>": "<text>" } }
 */

const NAME = "drafts";

/** Long enough for any real reply; a guard against a runaway writer. */
const MAX_LENGTH = 20_000;

const isDraft = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_LENGTH;

export async function getDrafts(key: string): Promise<Record<string, string>> {
  const store = await readNamespaced(NAME, isDraft);
  return store[key] ?? {};
}

/**
 * Save a draft, or clear it when `text` is empty or null — an empty box
 * should leave nothing behind to resurrect later.
 */
export async function setDraft(
  key: string,
  threadId: string,
  text: string | null,
): Promise<Record<string, string>> {
  if (!KEY.test(threadId)) throw new Error("Invalid thread id");
  if (text !== null && typeof text !== "string") {
    throw new Error("Invalid draft");
  }
  if (text !== null && text.length > MAX_LENGTH) {
    throw new Error("Invalid draft: too long");
  }

  const store = await readNamespaced(NAME, isDraft);
  const forPr = { ...(store[key] ?? {}) };

  if (text === null || text.trim() === "") delete forPr[threadId];
  else forPr[threadId] = text;

  store[key] = forPr;
  await writeNamespaced(NAME, store);
  return forPr;
}

export const DRAFTS_FILE = storePath(NAME);
