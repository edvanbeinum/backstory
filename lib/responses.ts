import { promises as fs } from "node:fs";

import {
  KEY,
  readNamespaced,
  storePath,
  withStore,
  writeNamespaced,
} from "./store";

/**
 * Everything you've done about one review comment, in one record.
 *
 * differ is a TODO tracker built from review comments and a drafting tool for
 * the replies, so a comment has exactly one thing attached to it: your
 * response. That used to be three separate ideas — an "ack", a commit link,
 * and a draft — spread across two files, with two of them doubling as the
 * done signal.
 *
 * Now `done` is the only thing that means handled, and nothing sets it but
 * you. Not linking a commit, not writing a reply, not a reply spotted on
 * GitHub. Working down a list and checking things off is the point; a flag
 * something else can set isn't a checklist.
 *
 * Shape: { "owner/repo#26": { "<threadId>": { done, doneAt, reply, commit } } }
 */

const NAME = "responses";
const SHA = /^[0-9a-f]{7,40}$/;
const PATCH_ID = /^[0-9a-f]{40}$/;

/** Long enough for any real reply; a guard against a runaway writer. */
const MAX_REPLY = 20_000;

export interface ResponseCommit {
  sha: string;
  /** Hashes the diff alone, so the link survives a rebase. */
  patchId: string | null;
}

export interface ResponseRecord {
  /** The tick. The only thing that means handled, and only you set it. */
  done: boolean;
  /** ms epoch, for "handled 2 minutes ago" and undo wording. */
  doneAt: number | null;
  /** Draft reply text. differ never posts it; it leaves via the clipboard. */
  reply: string | null;
  /**
   * The changes you say answer the comment, in the order you linked them.
   *
   * A list rather than one, because a long comment often makes several points
   * and gets answered by several commits. With a single slot the second one
   * was invisible: the reverse lookup said it answered nothing, and a rebase
   * only healed the link differ knew about.
   *
   * Never implies `done`.
   */
  commits: ResponseCommit[];
}

/**
 * A field-wise change. An absent field is left alone, which is what lets a
 * debounced draft save and a tick click touch the same record without either
 * clobbering the other's work.
 */
export interface ResponsePatch {
  done?: boolean;
  reply?: string | null;
  /** Append one, ignoring a sha already linked. */
  addCommit?: ResponseCommit;
  /** Drop one by sha. */
  removeCommit?: string;
  /** Replace the list outright — how healing re-points a rebased link. */
  commits?: ResponseCommit[];
}

export const EMPTY_RESPONSE: ResponseRecord = {
  done: false,
  doneAt: null,
  reply: null,
  commits: [],
};

/** The file is meant to be hand-editable, so nothing in it is trusted. */
type StoredResponse = Record<string, unknown>;

function isStoredResponse(value: unknown): value is StoredResponse {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCommit(value: unknown): ResponseCommit | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sha !== "string" || !SHA.test(record.sha)) return null;
  const patchId =
    typeof record.patchId === "string" && PATCH_ID.test(record.patchId)
      ? record.patchId
      : null;
  return { sha: record.sha, patchId };
}

function normalize(value: StoredResponse): ResponseRecord {
  const reply =
    typeof value.reply === "string" && value.reply.length <= MAX_REPLY
      ? value.reply
      : null;

  // `commit` is the shape this file held when a comment could only have one
  // answer. Read either; whichever it was, it's written back as a list the
  // next time this record is touched.
  const list = Array.isArray(value.commits)
    ? value.commits
    : value.commit !== undefined
      ? [value.commit]
      : [];

  const commits = list
    .map(normalizeCommit)
    .filter((c): c is ResponseCommit => c !== null);

  return {
    done: value.done === true,
    doneAt: typeof value.doneAt === "number" ? value.doneAt : null,
    reply,
    // A sha linked twice is one answer, not two.
    commits: commits.filter(
      (c, i) => commits.findIndex((o) => o.sha === c.sha) === i,
    ),
  };
}

/** A record holding nothing is deleted rather than stored as noise. */
function isEmpty(record: ResponseRecord): boolean {
  return !record.done && record.reply === null && record.commits.length === 0;
}

export function prKey(
  owner: string | null,
  name: string | null,
  prNumber: number,
): string | null {
  if (!owner || !name) return null;
  return `${owner}/${name}#${prNumber}`;
}

export async function getResponses(
  key: string,
): Promise<Record<string, ResponseRecord>> {
  await ensureMigrated();
  const store = await readNamespaced<StoredResponse>(NAME, isStoredResponse);
  return mapNamespace(store[key] ?? {});
}

/**
 * Every PR at once. The namespace key carries no filesystem path, so the
 * inbox gets handled-state for every worktree from this single read.
 */
export async function getAllResponses(): Promise<
  Record<string, Record<string, ResponseRecord>>
> {
  await ensureMigrated();
  const store = await readNamespaced<StoredResponse>(NAME, isStoredResponse);
  return Object.fromEntries(
    Object.entries(store).map(([key, entries]) => [key, mapNamespace(entries)]),
  );
}

function mapNamespace(
  entries: Record<string, StoredResponse>,
): Record<string, ResponseRecord> {
  return Object.fromEntries(
    Object.entries(entries).map(([id, value]) => [id, normalize(value)]),
  );
}

function validate(patch: ResponsePatch): void {
  if (patch.reply != null && patch.reply.length > MAX_REPLY) {
    throw new Error("Invalid reply: too long");
  }
  if (patch.removeCommit && !SHA.test(patch.removeCommit)) {
    throw new Error("Invalid commit sha");
  }
  for (const commit of [
    ...(patch.addCommit ? [patch.addCommit] : []),
    ...(patch.commits ?? []),
  ]) {
    if (!SHA.test(commit.sha)) throw new Error("Invalid commit sha");
    if (commit.patchId !== null && !PATCH_ID.test(commit.patchId)) {
      throw new Error("Invalid patch id");
    }
  }
}

/**
 * The only mutator, and batch-shaped on purpose.
 *
 * Every write is a read-modify-write of the whole file, so a loop of
 * single-record writes makes the last one win and silently drop the rest.
 * That has bitten this codebase before. Patches merge field-wise; `null`
 * deletes the record outright.
 */
export async function updateResponses(
  key: string,
  patches: Record<string, ResponsePatch | null>,
): Promise<Record<string, ResponseRecord>> {
  const ids = Object.keys(patches);
  if (ids.length === 0) return getResponses(key);

  for (const id of ids) {
    if (!KEY.test(id)) throw new Error("Invalid thread id");
    const patch = patches[id];
    if (patch) validate(patch);
  }

  await ensureMigrated();

  return withStore(NAME, async () => {
    const store = await readNamespaced<StoredResponse>(NAME, isStoredResponse);
    const forPr = mapNamespace(store[key] ?? {});

    for (const [id, patch] of Object.entries(patches)) {
      if (patch === null) {
        delete forPr[id];
        continue;
      }

      const before = forPr[id] ?? EMPTY_RESPONSE;
      const next: ResponseRecord = {
        ...before,
        ...(patch.done !== undefined
          ? {
              done: patch.done,
              // Only stamp on the transition, so re-ticking doesn't reset it.
              doneAt: patch.done
                ? (before.done ? before.doneAt : Date.now())
                : null,
            }
          : {}),
        ...(patch.reply !== undefined
          ? { reply: patch.reply === "" ? null : patch.reply }
          : {}),
        ...(patch.commits !== undefined ? { commits: patch.commits } : {}),
      };

      if (patch.addCommit) {
        next.commits = next.commits.some((c) => c.sha === patch.addCommit!.sha)
          ? next.commits
          : [...next.commits, patch.addCommit];
      }
      if (patch.removeCommit) {
        next.commits = next.commits.filter(
          (c) => c.sha !== patch.removeCommit,
        );
      }

      if (isEmpty(next)) delete forPr[id];
      else forPr[id] = next;
    }

    if (Object.keys(forPr).length === 0) delete store[key];
    else store[key] = forPr as unknown as Record<string, StoredResponse>;

    await writeNamespaced(NAME, store);
    return forPr;
  });
}

/* --- Migration from links.json + drafts.json -------------------------- */

/**
 * The two files this replaces, read through the validators they shipped with.
 * `links.json` has held three shapes over its life and the live data is
 * mostly the *middle* one, so this tolerance is the main path, not a courtesy
 * to history.
 */
type StoredLink =
  | { kind: "commit"; sha: string; patchId: string | null }
  | { kind: "ack" }
  | { sha: string; patchId?: string | null }
  | string;

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

const isDraft = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_REPLY;

/** A link was the old done signal, so it migrates to a tick. */
function linkToResponse(link: StoredLink, at: number): ResponseRecord {
  const base = { done: true, doneAt: at, reply: null };
  if (typeof link === "string") {
    return { ...base, commits: [{ sha: link, patchId: null }] };
  }
  if ("kind" in link && link.kind === "ack") return { ...base, commits: [] };
  const record = link as { sha: string; patchId?: string | null };
  return {
    ...base,
    commits: [{ sha: record.sha, patchId: record.patchId ?? null }],
  };
}

let migration: Promise<void> | null = null;

export function ensureMigrated(): Promise<void> {
  migration ??= migrate();
  return migration;
}

/**
 * Runs once, lazily, and only when there's nothing to lose: the presence of
 * responses.json ends it immediately, which is what makes a second run
 * harmless and stops it resurrecting records you've since cleared.
 *
 * Not wrapped in withStore — every accessor awaits this before taking the
 * lock, so no other write can be in flight, and taking the lock here would
 * deadlock against the caller that already holds it.
 */
async function migrate(): Promise<void> {
  try {
    await fs.access(storePath(NAME));
    return;
  } catch {
    // No responses.json yet — there may be legacy files to carry over.
  }

  const [links, drafts] = await Promise.all([
    readNamespaced<StoredLink>("links", isStoredLink),
    readNamespaced<string>("drafts", isDraft),
  ]);

  const prKeys = new Set([...Object.keys(links), ...Object.keys(drafts)]);
  if (prKeys.size === 0) return;

  // The link's file time is the closest honest answer to "when did you
  // decide this was handled" — better than stamping everything as now.
  let at = Date.now();
  try {
    at = (await fs.stat(storePath("links"))).mtimeMs;
  } catch {
    // No links file; drafts-only migration, and doneAt won't be read anyway.
  }

  const out: Record<string, Record<string, ResponseRecord>> = {};
  for (const key of prKeys) {
    const linksForPr = links[key] ?? {};
    const draftsForPr = drafts[key] ?? {};
    // Union, not links-driven: a draft with no link is a reply in progress on
    // a comment you haven't answered yet, and driving from links alone would
    // drop it. The live data has one.
    const ids = new Set([
      ...Object.keys(linksForPr),
      ...Object.keys(draftsForPr),
    ]);

    const forPr: Record<string, ResponseRecord> = {};
    for (const id of ids) {
      const link = linksForPr[id];
      const reply = draftsForPr[id] ?? null;
      const record = link
        ? { ...linkToResponse(link, at), reply }
        : { done: false, doneAt: null, reply, commits: [] };
      if (!isEmpty(record)) forPr[id] = record;
    }
    if (Object.keys(forPr).length > 0) out[key] = forPr;
  }

  await writeNamespaced(NAME, out);

  // Renamed, never deleted: being able to recover a store by hand is the
  // reason it's plain JSON in the first place.
  await Promise.all(
    ["links", "drafts"].map(async (name) => {
      try {
        await fs.rename(storePath(name), `${storePath(name)}.migrated`);
      } catch {
        // Wasn't there, or already renamed. Either way there's nothing to do.
      }
    }),
  );
}

/** Test seam: lets a fixture run the migration more than once per process. */
export function resetMigrationForTests(): void {
  migration = null;
}

export const RESPONSES_FILE = storePath(NAME);
