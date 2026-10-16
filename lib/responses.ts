import type { DatabaseSync } from "node:sqlite";

import { isObject, KEY, reading, transaction, type Legacy } from "./store";

/**
 * Everything you've done about one review comment, in one record: the
 * `responses` table.
 *
 * Backstory is a TODO tracker built from review comments and a drafting tool for
 * the replies, so a comment has exactly one thing attached to it: your
 * response.
 *
 * `done` is the only thing that means handled, and nothing sets it but you.
 * Not linking a commit, not writing a reply, not a reply spotted on GitHub.
 * Working down a list and checking things off is the point; a flag something
 * else can set isn't a checklist.
 */

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
  /** Draft reply text. Backstory never posts it; it leaves via the clipboard. */
  reply: string | null;
  /**
   * The changes you say answer the comment, in the order you linked them.
   *
   * A list rather than one, because a long comment often makes several points
   * and gets answered by several commits. With a single slot the second one
   * was invisible: the reverse lookup said it answered nothing, and a rebase
   * only healed the link Backstory knew about.
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

interface ResponseRow {
  pr: string;
  thread: string;
  done: number;
  done_at: number | null;
  reply: string | null;
  commits: string;
}

function toRecord(row: ResponseRow): ResponseRecord {
  return {
    done: row.done === 1,
    doneAt: row.done_at,
    reply: row.reply,
    commits: JSON.parse(row.commits) as ResponseCommit[],
  };
}

function read(
  database: DatabaseSync,
  key: string,
): Record<string, ResponseRecord> {
  const rows = database
    .prepare("SELECT * FROM responses WHERE pr = ?")
    .all(key) as unknown as ResponseRow[];
  return Object.fromEntries(rows.map((row) => [row.thread, toRecord(row)]));
}

function write(
  database: DatabaseSync,
  key: string,
  id: string,
  record: ResponseRecord,
): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO responses (pr, thread, done, done_at, reply, commits)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      id,
      record.done ? 1 : 0,
      record.doneAt,
      record.reply,
      JSON.stringify(record.commits),
    );
}

export async function getResponses(
  key: string,
): Promise<Record<string, ResponseRecord>> {
  return reading({}, (database) => read(database, key));
}

/**
 * Every PR at once. The PR key has no filesystem path in it, so the inbox
 * gets handled-state for every worktree from this single read.
 */
export async function getAllResponses(): Promise<
  Record<string, Record<string, ResponseRecord>>
> {
  return reading({}, (database) => {
    const rows = database
      .prepare("SELECT * FROM responses")
      .all() as unknown as ResponseRow[];
    const out: Record<string, Record<string, ResponseRecord>> = {};
    for (const row of rows) (out[row.pr] ??= {})[row.thread] = toRecord(row);
    return out;
  });
}

/**
 * A sha linked twice is one answer, not two. Healing can make two links the
 * same, when a rebase lands both on one commit.
 */
function onePerSha(commits: ResponseCommit[]): ResponseCommit[] {
  return commits.filter(
    (c, i) => commits.findIndex((o) => o.sha === c.sha) === i,
  );
}

function validate(patch: ResponsePatch): void {
  if (patch.reply != null) {
    if (typeof patch.reply !== "string") throw new Error("Invalid reply");
    if (patch.reply.length > MAX_REPLY)
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
 * The only mutator, and batch-shaped: every patch applies in one transaction,
 * or none does. Patches merge field-wise; `null` deletes the record outright.
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

  return transaction((database) => {
    const forPr = read(database, key);
    const remove = database.prepare(
      "DELETE FROM responses WHERE pr = ? AND thread = ?",
    );

    for (const [id, patch] of Object.entries(patches)) {
      if (patch === null) {
        remove.run(key, id);
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
                ? before.done
                  ? before.doneAt
                  : Date.now()
                : null,
            }
          : {}),
        ...(patch.reply !== undefined
          ? { reply: patch.reply === "" ? null : patch.reply }
          : {}),
        ...(patch.commits !== undefined
          ? { commits: onePerSha(patch.commits) }
          : {}),
      };

      if (patch.addCommit) {
        next.commits = next.commits.some((c) => c.sha === patch.addCommit!.sha)
          ? next.commits
          : [...next.commits, patch.addCommit];
      }
      if (patch.removeCommit) {
        next.commits = next.commits.filter((c) => c.sha !== patch.removeCommit);
      }

      if (isEmpty(next)) remove.run(key, id);
      else write(database, key, id, next);
    }

    return read(database, key);
  });
}

/* --- Import from responses.json -------------------------------------- */

function normalizeCommit(value: unknown): ResponseCommit | null {
  if (!isObject(value)) return null;
  if (typeof value.sha !== "string" || !SHA.test(value.sha)) return null;
  const patchId =
    typeof value.patchId === "string" && PATCH_ID.test(value.patchId)
      ? value.patchId
      : null;
  return { sha: value.sha, patchId };
}

function normalize(value: Record<string, unknown>): ResponseRecord {
  const reply =
    typeof value.reply === "string" && value.reply.length <= MAX_REPLY
      ? value.reply
      : null;

  // `commit` is the shape the file had when a comment could only have one
  // answer.
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
    commits: onePerSha(commits),
  };
}

/**
 * Copy the old `responses.json` in. A record keeps what checks out of it: an
 * unusable sha is dropped without losing the tick.
 */
export function importResponses(database: DatabaseSync, legacy: Legacy): void {
  for (const [key, entries] of Object.entries(legacy)) {
    for (const [id, value] of Object.entries(entries)) {
      if (!isObject(value)) continue;
      const record = normalize(value);
      if (!isEmpty(record)) write(database, key, id, record);
    }
  }
}
