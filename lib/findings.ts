import { present } from "./data/present";
import type { DataResponse } from "./data/types";
import type { Flow, FlowSet, FlowStep } from "./flows/types";

/**
 * Design questions, raised mechanically from what differ already holds: the
 * view's flows and its data model change. Each is a heuristic, so each is
 * phrased as a question and carries the evidence it fired on. None needs
 * Claude: the opinion stays with the reader.
 */

export interface Evidence {
  /** A flow and the step that shows it, for jumping there */
  flow?: number;
  step?: string;
  /** An entity in the data view */
  entity?: string;
  text: string;
}

export interface Finding {
  id: string;
  kind: "vendor-fields" | "two-ways" | "repeated-flows" | "busy-job";
  /** A few words, for the strip */
  short: string;
  /** The question, in a line */
  title: string;
  /** Why it's worth asking */
  why: string;
  evidence: Evidence[];
}

/** Lanes that are raw HTTP: calling one means speaking a protocol, not a domain. */
const HTTP = /^(Net::HTTP|HTTParty|Faraday|RestClient|Excon|URLSession|fetch|axios|requests|http\.Client|OkHttp)/i;

/** "ZoomClient" → "Zoom"; "ConnectedAccount::ZoomProvider" → "Zoom". */
function vendorOf(lane: string): string | null {
  const last = lane.split("::").pop() ?? lane;
  const m = last.match(/^([A-Z][a-z0-9]+)(Client|Provider|Gateway|Api|API|Adapter|Service)$/);
  return m ? m[1] : null;
}

/** Outside systems the change talks to, from its lanes and its new namespaces. */
export function vendors(set: FlowSet | null, data: DataResponse | null, known: string[] = []): string[] {
  const out = new Set<string>(known);
  for (const f of set?.flows ?? []) {
    for (const p of f.participants) {
      const v = vendorOf(p.name);
      if (v) out.add(v);
    }
  }
  for (const e of data?.entities ?? []) {
    if (e.state === "added" && e.name.includes("::")) out.add(e.name.split("::")[0]);
  }
  return [...out];
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** 1. A core entity takes an outside system's vocabulary. */
function vendorFields(data: DataResponse | null, names: string[]): Finding[] {
  const out: Finding[] = [];
  for (const p of present(data?.entities ?? [])) {
    if (p.state !== "changed") continue;
    for (const vendor of names) {
      const prefix = `${snake(vendor)}_`;
      const named = p.fields.filter((f) => f.state === "added" && f.item.name.toLowerCase().startsWith(prefix));
      if (named.length === 0) continue;
      const where = p.entity.component ? ` (${p.entity.component})` : "";
      out.push({
        id: `vendor-fields:${p.entity.name}:${vendor}`,
        kind: "vendor-fields",
        short: `${p.entity.name} takes ${vendor} fields`,
        title: `${p.entity.name}${where} gains ${named.length} ${named.length === 1 ? "field" : "fields"} named after ${vendor}`,
        why: `When a second source arrives, does ${p.entity.name} grow another set of fields? A ${vendor}-specific record linked to ${p.entity.name} would keep ${p.entity.name} the same.`,
        evidence: named.map((f) => ({ entity: p.entity.name, text: `+ ${f.item.name}` })),
      });
    }
  }
  return out;
}

/** 2. An outside system reached two ways: through its client, and over raw HTTP. */
function twoWays(set: FlowSet | null): Finding[] {
  if (!set) return [];
  const clients = new Map<string, string>();
  for (const f of set.flows) for (const p of f.participants) {
    const v = vendorOf(p.name);
    if (v && /Client$/.test(p.name)) clients.set(v, p.name);
  }
  if (clients.size === 0) return [];
  const raw: Evidence[] = [];
  set.flows.forEach((f, i) => {
    for (const s of f.after) {
      if (HTTP.test(s.to) && !vendorOf(s.from)?.length) {
        raw.push({ flow: i, step: s.id, text: `${s.from} → ${s.to}: ${s.label}` });
      }
    }
  });
  if (raw.length === 0) return [];
  const callers = [...new Set(raw.map((r) => r.text.split(" → ")[0]))];
  return [...clients].map(([vendor, client]) => ({
    id: `two-ways:${vendor}`,
    kind: "two-ways" as const,
    short: `${vendor} reached two ways`,
    title: `${vendor} is reached two ways: through ${client}, and directly over HTTP from ${callers.join(", ")}`,
    why: `If ${vendor} changes how it authenticates or rate-limits, how many places need fixing? A client that owns every call to ${vendor} would be one.`,
    evidence: raw,
  }));
}

/**
 * A call's identity across flows: who it's made on, and which method. A
 * call into the framework (a form post, a redirect) is plumbing every flow
 * shares, so it doesn't count toward two flows being alike.
 */
function signature(s: FlowStep, external: Set<string>): string | null {
  if (s.from === s.to || external.has(s.to)) return null;
  const method = s.label.replace(/^[^.(]*\.(?=\w)/, "").match(/^[\w!?]+/)?.[0] ?? s.label;
  return `${s.to}.${method}`;
}

interface Call {
  sig: string;
  /** Where the call is made: two flows reaching the same line share code, not copy it */
  site: string;
}

/**
 * The calls two flows both make, in order, from different places. The same
 * call from the same line is one piece of code two triggers reach (two
 * ways into one screen); the same call from two lines is a copy.
 */
function copied(a: Call[], b: Call[]): number {
  const same = (x: Call, y: Call) => x.sig === y.sig && x.site !== y.site;
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

/** 3. Two flows that make most of the same calls. */
function repeatedFlows(set: FlowSet | null): Finding[] {
  if (!set) return [];
  const out: Finding[] = [];
  const externals = set.flows.map((f) => new Set(f.participants.filter((p) => p.external).map((p) => p.name)));
  const calls: Call[][] = set.flows.map((f, i) =>
    f.after.flatMap((s) => {
      const sig = signature(s, externals[i]);
      return sig ? [{ sig, site: `${s.file}:${s.line}` }] : [];
    }),
  );
  for (let i = 0; i < set.flows.length; i++) {
    for (let j = i + 1; j < set.flows.length; j++) {
      const n = copied(calls[i], calls[j]);
      const shorter = Math.min(calls[i].length, calls[j].length);
      if (n < 3 || n < shorter * 0.4) continue;
      const a = set.flows[i];
      const b = set.flows[j];
      // Where they part: the same call made with different words.
      const differ: Evidence[] = [];
      for (const s of a.after) {
        const sig = signature(s, externals[i]);
        const twin = b.after.find(
          (t) =>
            sig &&
            signature(t, externals[j]) === sig &&
            t.label !== s.label &&
            `${t.file}:${t.line}` !== `${s.file}:${s.line}`,
        );
        if (twin) {
          differ.push({ flow: i, step: s.id, text: `${a.name}: ${s.label}` });
          differ.push({ flow: j, step: twin.id, text: `${b.name}: ${twin.label}` });
        }
      }
      out.push({
        id: `repeated:${a.id}:${b.id}`,
        kind: "repeated-flows",
        short: "two flows repeat each other",
        title: `"${a.name}" and "${b.name}" each make the same ${n} calls, from different code`,
        why:
          differ.length > 0
            ? "Two copies of one sequence tend to drift apart, and these already differ. Could they share one path?"
            : "Two copies of one sequence tend to drift apart. Could they share one path?",
        evidence: differ.length > 0 ? differ.slice(0, 6) : [{ flow: i, text: `${n} calls in common` }],
      });
    }
  }
  return out;
}

const JOB = /(Job|Worker)$/;

/** 4. A job doing the work itself rather than pressing a button on a model. */
function busyJobs(set: FlowSet | null): Finding[] {
  if (!set) return [];
  const out: Finding[] = [];
  set.flows.forEach((f: Flow, i) => {
    const jobs = new Set(f.after.map((s) => s.from).filter((n) => JOB.test(n)));
    for (const job of jobs) {
      const own = f.after.filter((s) => s.from === job);
      const self = own.filter((s) => s.to === job);
      const others = new Set(own.filter((s) => s.to !== job).map((s) => s.to));
      if (self.length < 3 && others.size < 4) continue;
      out.push({
        id: `busy-job:${job}:${f.id}`,
        kind: "busy-job",
        short: `${job} does the work itself`,
        title: `${job} does the work itself: ${self.length} steps of its own, calling ${others.size} other types`,
        why: "A job that only presses one button on a model can be tested without a queue, and the rule lives with the model it's about.",
        evidence: own.slice(0, 6).map((s) => ({ flow: i, step: s.id, text: `${s.to === job ? "itself" : s.to}: ${s.label}` })),
      });
    }
  });
  return out;
}

export function findings(set: FlowSet | null, data: DataResponse | null, known: string[] = []): Finding[] {
  const names = vendors(set, data, known);
  return [...vendorFields(data, names), ...twoWays(set), ...repeatedFlows(set), ...busyJobs(set)];
}
