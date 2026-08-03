import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
export type LinkStore = Record<string, Record<string, string>>;

const DIR = path.join(homedir(), ".differ");
const FILE = path.join(DIR, "links.json");

/** GitHub thread node ids are opaque base64-ish strings; be strict anyway. */
const THREAD_ID = /^[A-Za-z0-9_=-]{1,200}$/;
const SHA = /^[0-9a-f]{7,40}$/;

export function prKey(
  owner: string | null,
  name: string | null,
  prNumber: number,
): string | null {
  if (!owner || !name) return null;
  return `${owner}/${name}#${prNumber}`;
}

async function readStore(): Promise<LinkStore> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Re-validate on read: this file is on disk and could be hand-edited.
    const store: LinkStore = {};
    for (const [key, value] of Object.entries(parsed as LinkStore)) {
      if (!value || typeof value !== "object") continue;
      const inner: Record<string, string> = {};
      for (const [threadId, sha] of Object.entries(value)) {
        if (typeof sha === "string" && THREAD_ID.test(threadId) && SHA.test(sha)) {
          inner[threadId] = sha;
        }
      }
      store[key] = inner;
    }
    return store;
  } catch {
    // Missing or unreadable — pins are a convenience, never load-bearing.
    return {};
  }
}

async function writeStore(store: LinkStore): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  // Write-then-rename so a crash mid-write can't truncate existing pins.
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

export async function getLinks(key: string): Promise<Record<string, string>> {
  const store = await readStore();
  return store[key] ?? {};
}

/** Pin a thread to a commit, or unpin it when `sha` is null. */
export async function setLink(
  key: string,
  threadId: string,
  sha: string | null,
): Promise<Record<string, string>> {
  if (!THREAD_ID.test(threadId)) {
    throw new Error("Invalid thread id");
  }
  if (sha !== null && !SHA.test(sha)) {
    throw new Error("Invalid commit sha");
  }

  const store = await readStore();
  const forPr = { ...(store[key] ?? {}) };

  if (sha === null) delete forPr[threadId];
  else forPr[threadId] = sha;

  store[key] = forPr;
  await writeStore(store);
  return forPr;
}

export const LINKS_FILE = FILE;
