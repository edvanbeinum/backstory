import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { writeNotes } from "./notes";
import {
  isObject,
  isTime,
  KEY,
  reading,
  transaction,
  type Legacy,
} from "./store";
import type { Note } from "./types";

/**
 * Sent rounds on their way to an agent, per checkout: the `rounds` and `seen`
 * tables.
 *
 * `backstory review` only reaches an agent that's sitting waiting on stdout, and
 * that wait lives in memory. This is the other road: Send files the round
 * here, on disk, and the agent's Claude Code Stop hook (`backstory hook stop`)
 * collects it the next time that session finishes a turn. So Send works while
 * the agent is busy, and survives a restart of either side.
 *
 * A round is aimed at the session last seen stopping in its checkout, so a
 * second session there doesn't collect notes meant for the first. Only a
 * round aimed at nobody — none seen yet, or you said "the next one" — goes to
 * whichever stops first.
 *
 * Copied and directly-answered rounds are recorded too, already delivered, so
 * the window can say how every round left.
 */

/** Long enough for any real review; a guard against a runaway writer. */
export const MAX_MESSAGE = 200_000;

/** Delivered rounds are only kept to label their round in the window. */
const KEEP_DELIVERED_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long a taken round waits for its hook to say the agent has it before
 * it can be taken again. Longer than a hook can run: Backstory's exits by 5s.
 */
export const CLAIM_MS = 30_000;
/** Sessions remembered per checkout; only the latest is ever aimed at. */
const KEEP_SESSIONS = 10;

export const CLIPBOARD = "clipboard";
export const BACKSTORY_REVIEW = "backstory review";

export interface OutboxRound {
  id: string;
  root: string;
  noteIds: string[];
  /** Built at Send, so what the agent reads is what you sent. */
  message: string;
  /** Matches the notes' `sentAt`, which is what ties this to its round. */
  queuedAt: number;
  /** The session it's for; null for whichever stops here first. */
  forSession: string | null;
  deliveredAt: number | null;
  /** A session id, CLIPBOARD or BACKSTORY_REVIEW. */
  deliveredTo: string | null;
  /**
   * Handed to a Stop hook that hasn't yet confirmed printing it. Delivered
   * only on that confirmation, so a hook that gave up waiting doesn't lose it.
   */
  claim: { session: string; until: number } | null;
}

export interface OutboxState {
  rounds: OutboxRound[];
  /** The last session seen stopping in this checkout, and when. */
  lastSeen: { session: string; at: number } | null;
  /** Every remembered session's last stop, for "active here 5m ago". */
  seen: Record<string, number>;
}

export const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && KEY.test(value);

interface RoundRow {
  id: string;
  root: string;
  note_ids: string;
  message: string;
  queued_at: number;
  for_session: string | null;
  delivered_at: number | null;
  delivered_to: string | null;
  claim_session: string | null;
  claim_until: number | null;
}

function toRound(row: RoundRow): OutboxRound {
  return {
    id: row.id,
    root: row.root,
    noteIds: JSON.parse(row.note_ids) as string[],
    message: row.message,
    queuedAt: row.queued_at,
    forSession: row.for_session,
    deliveredAt: row.delivered_at,
    deliveredTo: row.delivered_to,
    claim:
      row.claim_session !== null && row.claim_until !== null
        ? { session: row.claim_session, until: row.claim_until }
        : null,
  };
}

function insertRound(database: DatabaseSync, round: OutboxRound): void {
  database
    .prepare(
      `INSERT INTO rounds
         (root, id, note_ids, message, queued_at, for_session, delivered_at,
          delivered_to, claim_session, claim_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      round.root,
      round.id,
      JSON.stringify(round.noteIds),
      round.message,
      round.queuedAt,
      round.forSession,
      round.deliveredAt,
      round.deliveredTo,
      round.claim?.session ?? null,
      round.claim?.until ?? null,
    );
}

function getRound(
  database: DatabaseSync,
  root: string,
  id: string,
): OutboxRound | null {
  const row = database
    .prepare("SELECT * FROM rounds WHERE root = ? AND id = ?")
    .get(root, id) as unknown as RoundRow | undefined;
  return row ? toRound(row) : null;
}

/**
 * Newest first. The rowid breaks a tie: a stop recorded later in the same
 * millisecond is the later one.
 */
function seenRows(
  database: DatabaseSync,
  root: string,
): { session: string; at: number }[] {
  const rows = database
    .prepare(
      "SELECT session, at FROM seen WHERE root = ? ORDER BY at DESC, rowid DESC",
    )
    .all(root) as unknown as { session: string; at: number }[];
  return rows.map(({ session, at }) => ({ session, at }));
}

function lastSeen(
  database: DatabaseSync,
  root: string,
): OutboxState["lastSeen"] {
  return seenRows(database, root)[0] ?? null;
}

export async function getOutbox(root: string): Promise<OutboxState> {
  return reading<OutboxState>(
    { rounds: [], lastSeen: null, seen: {} },
    (database) => {
      const rows = database
        .prepare(
          "SELECT * FROM rounds WHERE root = ? ORDER BY queued_at DESC, rowid",
        )
        .all(root) as unknown as RoundRow[];
      const seen = seenRows(database, root);
      return {
        rounds: rows.map(toRound),
        lastSeen: seen[0] ?? null,
        seen: Object.fromEntries(seen.map((s) => [s.session, s.at])),
      };
    },
  );
}

/*
 * On globalThis for the same reason as review requests: Next may load this
 * module once per route bundle, and the route that writes must reach the
 * watch stream's listener.
 */
const g = globalThis as { __backstoryOutbox?: EventEmitter };
const events: EventEmitter = (g.__backstoryOutbox ??=
  new EventEmitter().setMaxListeners(0));

/** Be told when a checkout's rounds change: queued, taken, re-aimed, withdrawn. */
export function onOutboxChange(listener: (root: string) => void): () => void {
  events.on("change", listener);
  return () => events.off("change", listener);
}

/**
 * Run one checkout's change in a transaction, and tell the watch stream once
 * it has committed. A change that throws rejects rather than throwing, as an
 * async write would.
 */
function change<T>(
  root: string,
  fn: (database: DatabaseSync) => { result: T; changed: boolean },
): Promise<T> {
  return new Promise((resolve) => {
    const { result, changed } = transaction((database) => {
      const outcome = fn(database);
      if (outcome.changed) {
        database
          .prepare("DELETE FROM rounds WHERE root = ? AND delivered_at < ?")
          .run(root, Date.now() - KEEP_DELIVERED_MS);
      }
      return outcome;
    });
    if (changed) events.emit("change", root);
    resolve(result);
  });
}

export interface NewRound {
  noteIds: string[];
  message: string;
  at: number;
  /** Set when it's already been handed over: CLIPBOARD or BACKSTORY_REVIEW. */
  deliveredTo?: string;
}

function checkNewRound(round: NewRound): void {
  if (!round.noteIds.every((id) => KEY.test(id)))
    throw new Error("Invalid note id");
  if (round.message.length > MAX_MESSAGE)
    throw new Error("Invalid message: too long");
}

/**
 * Undelivered, a round is aimed at the session last seen stopping here — or
 * at nobody, when none has been.
 */
function file(
  database: DatabaseSync,
  root: string,
  round: NewRound,
): OutboxRound {
  const delivered = round.deliveredTo !== undefined;
  const entry: OutboxRound = {
    id: randomUUID(),
    root,
    noteIds: round.noteIds,
    message: round.message,
    queuedAt: round.at,
    forSession: delivered ? null : (lastSeen(database, root)?.session ?? null),
    deliveredAt: delivered ? Date.now() : null,
    deliveredTo: round.deliveredTo ?? null,
    claim: null,
  };
  insertRound(database, entry);
  return entry;
}

/**
 * Send: file the round and mark its notes sent at the round's time, in one
 * transaction, so there's never a round with drafts or sent notes with no
 * round.
 */
export function sendRound(
  root: string,
  round: NewRound,
): Promise<{ round: OutboxRound; notes: Note[] }> {
  checkNewRound(round);
  return change(root, (database) => {
    const filed = file(database, root, round);
    const notes = writeNotes(root, {
      op: "send",
      ids: filed.noteIds,
      at: round.at,
    });
    return { result: { round: filed, notes }, changed: true };
  });
}

const claimed = (round: OutboxRound, now = Date.now()) =>
  round.claim !== null && round.claim.until > now;

/**
 * A session finished a turn here: note it, and hand it every undelivered round
 * aimed at it or at nobody, claiming them for it — one transaction, so two
 * sessions stopping at once can't both collect a round. They're delivered
 * once the hook confirms with `ack`.
 */
export function take(root: string, session: string): Promise<OutboxRound[]> {
  if (!isSessionId(session)) throw new Error("Invalid session id");

  return change(root, (database) => {
    const now = Date.now();
    database
      .prepare(
        "INSERT OR REPLACE INTO seen (root, session, at) VALUES (?, ?, ?)",
      )
      .run(root, session, now);
    const forget = database.prepare(
      "DELETE FROM seen WHERE root = ? AND session = ?",
    );
    for (const old of seenRows(database, root).slice(KEEP_SESSIONS)) {
      forget.run(root, old.session);
    }

    const rows = database
      .prepare(
        `SELECT * FROM rounds
         WHERE root = ? AND delivered_at IS NULL
           AND (for_session IS NULL OR for_session = ?)
         ORDER BY queued_at, rowid`,
      )
      .all(root, session) as unknown as RoundRow[];
    const claim = database.prepare(
      "UPDATE rounds SET claim_session = ?, claim_until = ? WHERE root = ? AND id = ?",
    );
    const taken: OutboxRound[] = [];
    for (const round of rows.map(toRound)) {
      if (claimed(round, now) && round.claim?.session !== session) continue;
      round.claim = { session, until: now + CLAIM_MS };
      claim.run(session, round.claim.until, root, round.id);
      taken.push(round);
    }
    return { result: taken, changed: true };
  });
}

/**
 * The hook printed what it took: those rounds are delivered. Only rounds this
 * session still holds; returns how many.
 */
export function ack(
  root: string,
  session: string,
  ids: string[],
): Promise<number> {
  if (!isSessionId(session)) throw new Error("Invalid session id");

  return change(root, (database) => {
    const deliver = database.prepare(
      `UPDATE rounds
       SET delivered_at = ?, delivered_to = ?, claim_session = NULL, claim_until = NULL
       WHERE root = ? AND id = ? AND delivered_at IS NULL AND claim_session = ?`,
    );
    const now = Date.now();
    let count = 0;
    for (const id of ids) {
      count += Number(deliver.run(now, session, root, id, session).changes);
    }
    return { result: count, changed: count > 0 };
  });
}

/** Re-aim a waiting round. Null if it's gone or already delivered. */
export function retarget(
  root: string,
  id: string,
  forSession: string | null,
): Promise<OutboxRound | null> {
  if (forSession !== null && !isSessionId(forSession)) {
    throw new Error("Invalid session id");
  }
  return change(root, (database) => {
    const round = getRound(database, root, id);
    if (!round || round.deliveredAt !== null)
      return { result: null, changed: false };
    database
      .prepare("UPDATE rounds SET for_session = ? WHERE root = ? AND id = ?")
      .run(forSession, root, id);
    round.forSession = forSession;
    return { result: round, changed: true };
  });
}

/** Null if the round is gone or an agent has it, or may be reading it now. */
function withdraw(database: DatabaseSync, root: string, id: string) {
  const round = getRound(database, root, id);
  if (!round || round.deliveredAt !== null || claimed(round)) return null;
  database
    .prepare("DELETE FROM rounds WHERE root = ? AND id = ?")
    .run(root, id);
  return round;
}

/**
 * Cancel: withdraw a waiting round and return its notes to drafts, in one
 * transaction. Null, with nothing written, when it's gone or an agent has it.
 */
export function cancelRound(root: string, id: string): Promise<Note[] | null> {
  return change(root, (database) => {
    const round = withdraw(database, root, id);
    if (!round) return { result: null, changed: false };
    const notes = writeNotes(root, { op: "unsend", ids: round.noteIds });
    return { result: notes, changed: true };
  });
}

/**
 * The agent a round was filed for as answered had gone by the time it was
 * answered: queue it instead, aimed as Send would have.
 */
export function requeue(root: string, id: string): Promise<OutboxRound | null> {
  return change(root, (database) => {
    const round = getRound(database, root, id);
    if (!round) return { result: null, changed: false };
    round.deliveredAt = null;
    round.deliveredTo = null;
    round.forSession = lastSeen(database, root)?.session ?? null;
    database
      .prepare(
        `UPDATE rounds SET delivered_at = NULL, delivered_to = NULL, for_session = ?
         WHERE root = ? AND id = ?`,
      )
      .run(round.forSession, root, id);
    return { result: round, changed: true };
  });
}

/**
 * What the Stop hook hands the agent: the rounds it took, in the order they
 * were sent, under enough of a preamble to read them cold — this agent may
 * never have been told about Backstory.
 */
export function formatTaken(rounds: OutboxRound[]): string {
  return (
    [
      "I reviewed your work in Backstory and sent these notes while you were busy. " +
        "Address every note, then summarise what you changed for each. " +
        "Find a line by its quoted text if the number has drifted. " +
        "For a note on a commit, tell me how you mean to fix it (a fixup, a new " +
        "commit on top, …) and wait for me to agree before rewriting history.",
      ...rounds.map((r) => r.message.trimEnd()),
    ].join("\n\n---\n\n") + "\n"
  );
}

/* --- Import from outbox.json ----------------------------------------- */

const isTimeOrNull = (value: unknown) => value === null || isTime(value);

const isClaim = (value: unknown) =>
  value === undefined ||
  value === null ||
  (isObject(value) && isSessionId(value.session) && isTime(value.until));

function isRound(value: unknown): value is Omit<
  OutboxRound,
  "id" | "root" | "claim"
> & {
  claim?: OutboxRound["claim"];
} {
  if (!isObject(value)) return false;
  return (
    Array.isArray(value.noteIds) &&
    value.noteIds.every((id) => typeof id === "string" && KEY.test(id)) &&
    typeof value.message === "string" &&
    value.message.length <= MAX_MESSAGE &&
    isTime(value.queuedAt) &&
    (value.forSession === null || isSessionId(value.forSession)) &&
    isTimeOrNull(value.deliveredAt) &&
    (value.deliveredTo === null || typeof value.deliveredTo === "string") &&
    isClaim(value.claim)
  );
}

function isSeen(value: unknown): value is Record<string, number> {
  if (!isObject(value)) return false;
  return Object.entries(value).every(
    ([session, at]) => isSessionId(session) && isTime(at),
  );
}

/**
 * Copy the old `outbox.json` in, skipping any entry that doesn't check out.
 * Under each checkout, "seen" holds sessions and any other key is a round.
 */
export function importOutbox(database: DatabaseSync, legacy: Legacy): void {
  const see = database.prepare(
    "INSERT OR REPLACE INTO seen (root, session, at) VALUES (?, ?, ?)",
  );
  for (const [root, entries] of Object.entries(legacy)) {
    for (const [key, value] of Object.entries(entries)) {
      if (key === "seen") {
        if (!isSeen(value)) continue;
        for (const [session, at] of Object.entries(value)) {
          see.run(root, session, at);
        }
      } else if (isRound(value)) {
        insertRound(database, {
          id: key,
          root,
          noteIds: value.noteIds,
          message: value.message,
          queuedAt: value.queuedAt,
          forSession: value.forSession,
          deliveredAt: value.deliveredAt,
          deliveredTo: value.deliveredTo,
          claim: value.claim ?? null,
        });
      }
    }
  }
}
