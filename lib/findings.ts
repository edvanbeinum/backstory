import { present } from "./data/present";
import type { DataResponse } from "./data/types";
import type { FlowSet, FlowStep } from "./flows/types";

/**
 * Notes on the shape of a change, worked out from what differ already
 * holds: the view's flows and its data model change. Each states a fact
 * worth a look, with the evidence, and says where it belongs on the
 * diagrams. They don't judge: whether a pattern is a problem is the
 * reader's call, and the reviewer's.
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
  kind: "vendor-fields" | "two-ways" | "repeated-flows";
  /** A few words, for the strip and for the place it's pinned */
  short: string;
  /** The fact, in a line */
  title: string;
  evidence: Evidence[];
  /** Where it's pinned: an entity in the data view, or flows */
  on: { entity?: string; flows?: number[] };
  /** For a pinned flow, what the note says there */
  flowText?: Record<number, string>;
}

/**
 * Lanes that are raw HTTP: calling one means speaking a protocol, not a
 * domain. Names vary by tracer ("Net::HTTP", "NetHTTP", "Faraday::Connection"),
 * but the library's name must end there: "RequestsController" isn't HTTP.
 */
const HTTP = /^(Net(::)?HTTP|HTTParty|Faraday|RestClient|Excon|URLSession|fetch|axios|requests|http\.Client|OkHttp)(?![a-z0-9])/i;

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
      const fields = `${named.length} ${vendor} ${named.length === 1 ? "field" : "fields"}`;
      out.push({
        id: `vendor-fields:${p.entity.name}:${vendor}`,
        kind: "vendor-fields",
        short: `${p.entity.name} gains ${fields}`,
        title: `${p.entity.name}${where} gains ${fields}`,
        evidence: named.map((f) => ({ entity: p.entity.name, text: `+ ${f.item.name}` })),
        on: { entity: p.entity.name },
      });
    }
  }
  return out;
}

/**
 * 2. An outside system reached two ways: through its client, and over raw
 * HTTP. A raw call counts toward a vendor only when it names the vendor (its
 * caller, label or file): a Slack webhook says nothing about Zoom.
 */
function twoWays(set: FlowSet | null): Finding[] {
  if (!set) return [];
  // Clients at the head only: one the change removed isn't "elsewhere".
  const clients = new Map<string, string>();
  for (const f of set.flows) for (const s of f.after) for (const lane of [s.from, s.to]) {
    const v = vendorOf(lane);
    if (v && /Client$/.test(lane)) clients.set(v, lane);
  }
  const out: Finding[] = [];
  for (const [vendor, client] of clients) {
    const named = vendor.toLowerCase();
    const raw: Evidence[] = [];
    set.flows.forEach((f, i) => {
      for (const s of f.after) {
        if (!HTTP.test(s.to) || vendorOf(s.from)) continue;
        if (!`${s.from} ${s.label} ${s.file}`.toLowerCase().includes(named)) continue;
        raw.push({ flow: i, step: s.id, text: `${s.from} → ${s.to}: ${s.label}` });
      }
    });
    if (raw.length > 0) out.push(twoWaysNote(vendor, client, raw));
  }
  return out;
}

function twoWaysNote(vendor: string, client: string, raw: Evidence[]): Finding {
  const callers = [...new Set(raw.map((r) => r.text.split(" → ")[0]))];
  const flows = [...new Set(raw.map((r) => r.flow!))];
  return {
    id: `two-ways:${vendor}`,
    kind: "two-ways",
    short: `${vendor} called two ways`,
    title: `${vendor} is called through ${client}, and directly over HTTP from ${callers.join(", ")}`,
    evidence: raw,
    on: { flows },
    flowText: Object.fromEntries(
      flows.map((f) => [f, `Calls ${vendor} over HTTP directly; elsewhere ${client} does`]),
    ),
  };
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
      const parts: string[] = [];
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
          parts.push(sig!.split(".").pop()!);
          differ.push({ flow: i, step: s.id, text: `${a.name}: ${s.label}` });
          differ.push({ flow: j, step: twin.id, text: `${b.name}: ${twin.label}` });
        }
      }
      const at = parts.length
        ? `; ${parts.length === n ? "all" : parts.length} of them ${parts.length === 1 ? "differs" : "differ"} in what's passed`
        : "";
      out.push({
        id: `repeated:${a.id}:${b.id}`,
        kind: "repeated-flows",
        short: `flows ${i + 1} and ${j + 1} share ${n} calls`,
        title: `"${a.name}" and "${b.name}" make the same ${n} calls from different places${at}`,
        evidence: differ.length > 0 ? differ.slice(0, 6) : [{ flow: i, text: `${n} calls in common` }],
        on: { flows: [i, j] },
        flowText: {
          [i]: `Makes ${n} of the same calls as flow ${j + 1}, from different code${at}`,
          [j]: `Makes ${n} of the same calls as flow ${i + 1}, from different code${at}`,
        },
      });
    }
  }
  return out;
}

export function findings(set: FlowSet | null, data: DataResponse | null, known: string[] = []): Finding[] {
  const names = vendors(set, data, known);
  return [...vendorFields(data, names), ...twoWays(set), ...repeatedFlows(set)];
}
