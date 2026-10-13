import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { KEY, readNamespaced, withStore, writeNamespaced } from "./store";

/**
 * Sent rounds on their way to an agent, per checkout.
 *
 * `backstory review` only reaches an agent that's sitting waiting on stdout, and
 * that wait lives in memory. This is the other road: Send files the round
 * here, on disk, and the agent's Claude Code Stop hook (`backstory hook stop`)
 * collects it the next time that session finishes a turn. So Send works while
 * the agent is busy, and survives a restart of either side.
 *
 * A round is aimed at the session last seen stopping in its checkout, so a
 * second session there doesn't walk off with notes meant for the first. Only
 * a round aimed at nobody — none seen yet, or you said "the next one" — goes
 * to whichever stops first.
 *
 * Copied and directly-answered rounds are recorded too, already delivered, so
 * the window can say how every round left.
 *
 * Shape: { "/abs/worktree": { "<roundId>": Round, "seen": { "<session>": at } } }
 */

const NAME = "outbox";
const SEEN = "seen";

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

const isTime = (value: unknown) => value === null || typeof value === "number";

const isClaim = (value: unknown) =>
  value === undefined ||
  value === null ||
  (isObject(value) &&
    isSessionId(value.session) &&
    typeof value.until === "number");

function isRound(value: unknown): value is Omit<
  OutboxRound,
  "id" | "root" | "claim"
> & {
  claim?: OutboxRound["claim"];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.noteIds) &&
    r.noteIds.every((id) => typeof id === "string" && KEY.test(id)) &&
    typeof r.message === "string" &&
    r.message.length <= MAX_MESSAGE &&
    typeof r.queuedAt === "number" &&
    (r.forSession === null || isSessionId(r.forSession)) &&
    isTime(r.deliveredAt) &&
    (r.deliveredTo === null || typeof r.deliveredTo === "string") &&
    isClaim(r.claim)
  );
}

function isSeen(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([session, at]) => isSessionId(session) && typeof at === "number",
  );
}

/**
 * The file is meant to be hand-editable, so each entry is checked by the key
 * it sits under: "seen" holds sessions, anything else is a round.
 */
type Stored = Record<string, unknown>;
const isObject = (value: unknown): value is Stored =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

interface ForRoot {
  rounds: Map<string, OutboxRound>;
  seen: Record<string, number>;
}

function parse(root: string, entries: Record<string, Stored>): ForRoot {
  const rounds = new Map<string, OutboxRound>();
  let seen: Record<string, number> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (key === SEEN) {
      if (isSeen(value)) seen = value;
    } else if (isRound(value)) {
      rounds.set(key, {
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
  return { rounds, seen };
}

function serialize(forRoot: ForRoot): Record<string, Stored> {
  const out: Record<string, Stored> = {};
  if (Object.keys(forRoot.seen).length > 0) out[SEEN] = forRoot.seen;
  for (const round of forRoot.rounds.values()) {
    const { id, root: _root, ...rest } = round;
    out[id] = rest as unknown as Stored;
  }
  return out;
}

function lastSeen(seen: Record<string, number>): OutboxState["lastSeen"] {
  let best: OutboxState["lastSeen"] = null;
  for (const [session, at] of Object.entries(seen)) {
    if (!best || at > best.at) best = { session, at };
  }
  return best;
}

function state(forRoot: ForRoot): OutboxState {
  return {
    rounds: [...forRoot.rounds.values()].sort(
      (a, b) => b.queuedAt - a.queuedAt,
    ),
    lastSeen: lastSeen(forRoot.seen),
    seen: forRoot.seen,
  };
}

async function read(): Promise<Record<string, Record<string, Stored>>> {
  return readNamespaced<Stored>(NAME, isObject);
}

export async function getOutbox(root: string): Promise<OutboxState> {
  const store = await read();
  return state(parse(root, store[root] ?? {}));
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
 * Read-modify-write one checkout's entries under the store lock. The change
 * returns a value; the write only happens if `fn` says something changed.
 */
async function change<T>(
  root: string,
  fn: (forRoot: ForRoot) => { result: T; changed: boolean },
): Promise<T> {
  const outcome = await withStore(NAME, async () => {
    const store = await read();
    const forRoot = parse(root, store[root] ?? {});
    const { result, changed } = fn(forRoot);
    if (changed) {
      const now = Date.now();
      for (const [id, round] of forRoot.rounds) {
        if (
          round.deliveredAt !== null &&
          now - round.deliveredAt > KEEP_DELIVERED_MS
        ) {
          forRoot.rounds.delete(id);
        }
      }
      const serialized = serialize(forRoot);
      if (Object.keys(serialized).length === 0) delete store[root];
      else store[root] = serialized;
      await writeNamespaced(NAME, store);
    }
    return { result, changed };
  });
  if (outcome.changed) events.emit("change", root);
  return outcome.result;
}

export interface NewRound {
  noteIds: string[];
  message: string;
  at: number;
  /** Set when it's already been handed over: CLIPBOARD or BACKSTORY_REVIEW. */
  deliveredTo?: string;
}

/**
 * File a sent round. Undelivered, it's aimed at the session last seen
 * stopping here — or at nobody, when none has been.
 */
export function queueRound(
  root: string,
  round: NewRound,
): Promise<OutboxRound> {
  if (!round.noteIds.every((id) => KEY.test(id)))
    throw new Error("Invalid note id");
  if (round.message.length > MAX_MESSAGE)
    throw new Error("Invalid message: too long");

  return change(root, (forRoot) => {
    const delivered = round.deliveredTo !== undefined;
    const entry: OutboxRound = {
      id: randomUUID(),
      root,
      noteIds: round.noteIds,
      message: round.message,
      queuedAt: round.at,
      forSession: delivered ? null : (lastSeen(forRoot.seen)?.session ?? null),
      deliveredAt: delivered ? Date.now() : null,
      deliveredTo: round.deliveredTo ?? null,
      claim: null,
    };
    forRoot.rounds.set(entry.id, entry);
    return { result: entry, changed: true };
  });
}

/**
 * A session finished a turn here: note it, and hand it every undelivered round
 * aimed at it or at nobody, claiming them for it — one write, under the lock,
 * so two sessions stopping at once can't both collect a round. They're
 * delivered once the hook confirms with `ack`.
 */
export function take(root: string, session: string): Promise<OutboxRound[]> {
  if (!isSessionId(session)) throw new Error("Invalid session id");

  return change(root, (forRoot) => {
    const now = Date.now();
    forRoot.seen[session] = now;
    const kept = Object.entries(forRoot.seen)
      .sort(([, a], [, b]) => b - a)
      .slice(0, KEEP_SESSIONS);
    forRoot.seen = Object.fromEntries(kept);

    const taken: OutboxRound[] = [];
    for (const round of forRoot.rounds.values()) {
      if (round.deliveredAt !== null) continue;
      if (round.forSession !== null && round.forSession !== session) continue;
      if (claimed(round, now) && round.claim?.session !== session) continue;
      round.claim = { session, until: now + CLAIM_MS };
      taken.push(round);
    }
    taken.sort((a, b) => a.queuedAt - b.queuedAt);
    return { result: taken, changed: true };
  });
}

const claimed = (round: OutboxRound, now = Date.now()) =>
  round.claim !== null && round.claim.until > now;

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

  return change(root, (forRoot) => {
    const now = Date.now();
    let count = 0;
    for (const id of ids) {
      const round = forRoot.rounds.get(id);
      if (
        !round ||
        round.deliveredAt !== null ||
        round.claim?.session !== session
      )
        continue;
      round.deliveredAt = now;
      round.deliveredTo = session;
      round.claim = null;
      count++;
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
  return change(root, (forRoot) => {
    const round = forRoot.rounds.get(id);
    if (!round || round.deliveredAt !== null)
      return { result: null, changed: false };
    round.forSession = forSession;
    return { result: round, changed: true };
  });
}

/**
 * Withdraw a waiting round. Returns it, so the caller can put its notes back
 * to drafts; null if it's gone or an agent has it, or may be reading it now.
 */
export function cancel(root: string, id: string): Promise<OutboxRound | null> {
  return change(root, (forRoot) => {
    const round = forRoot.rounds.get(id);
    if (!round || round.deliveredAt !== null || claimed(round)) {
      return { result: null, changed: false };
    }
    forRoot.rounds.delete(id);
    return { result: round, changed: true };
  });
}

/**
 * Undo a write whose partner failed: drop a round just filed, or put back
 * one just withdrawn, exactly as it was.
 */
export function revert(
  root: string,
  id: string,
  round: OutboxRound | null,
): Promise<void> {
  return change(root, (forRoot) => {
    if (round) forRoot.rounds.set(id, round);
    else forRoot.rounds.delete(id);
    return { result: undefined, changed: true };
  });
}

/**
 * The agent a round was filed for as answered had gone by the time it was
 * answered: queue it instead, aimed as Send would have.
 */
export function requeue(root: string, id: string): Promise<OutboxRound | null> {
  return change(root, (forRoot) => {
    const round = forRoot.rounds.get(id);
    if (!round) return { result: null, changed: false };
    round.deliveredAt = null;
    round.deliveredTo = null;
    round.forSession = lastSeen(forRoot.seen)?.session ?? null;
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
