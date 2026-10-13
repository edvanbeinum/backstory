import type { Flow, FlowParticipant, FlowSet, FlowStep } from "./types";

/**
 * The cache is SARIF 2.1.0: one informational result per flow, its steps as
 * `codeFlows` thread flows ("after" at the head, "before" at the base).
 * Whatever SARIF has no field for goes in `backstory.*` properties.
 */

interface SarifLocation {
  location: {
    physicalLocation: {
      artifactLocation: { uri: string; uriBaseId: string };
      region: { startLine: number };
    };
    logicalLocations: { fullyQualifiedName: string; kind: string }[];
    message: { text: string };
  };
  kinds: string[];
  executionOrder: number;
  nestingLevel: number;
  properties: Record<string, unknown>;
}

interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: {
    tool: {
      driver: { name: string; version: string; rules: { id: string }[] };
    };
    versionControlProvenance: { repositoryUri: string; revisionId: string }[];
    logicalLocations: {
      name: string;
      fullyQualifiedName: string;
      kind: string;
      properties: Record<string, unknown>;
    }[];
    results: {
      ruleId: string;
      kind: string;
      message: { text: string };
      properties: Record<string, unknown>;
      codeFlows: {
        threadFlows: { id: string; locations: SarifLocation[] }[];
      }[];
    }[];
    properties: Record<string, unknown>;
  }[];
}

const NS = "backstory";

function props(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [`${NS}.${key}`, value]),
  );
}

/** A property by its short name. */
const prop = (bag: Record<string, unknown>, key: string): unknown =>
  bag[`${NS}.${key}`];

const toLocation = (s: FlowStep, i: number): SarifLocation => ({
  location: {
    physicalLocation: {
      artifactLocation: { uri: s.file, uriBaseId: "SRCROOT" },
      region: { startLine: s.line },
    },
    logicalLocations: [{ fullyQualifiedName: s.caller, kind: "function" }],
    message: { text: s.label },
  },
  kinds: ["call"],
  executionOrder: i + 1,
  nestingLevel: s.nesting,
  properties: props(
    Object.fromEntries(
      Object.entries({
        stepId: s.id,
        from: s.from,
        to: s.to,
        symbol: s.symbol,
        returns: s.returns,
        repeat: s.repeat,
        sameAs: s.sameAs,
        verified: s.verified,
      }).filter(([, v]) => v !== undefined && v !== ""),
    ),
  ),
});

const fromLocation = (l: SarifLocation): FlowStep => {
  const p = l.properties;
  const str = (key: string) => {
    const value = prop(p, key);
    return typeof value === "string" ? value : undefined;
  };
  const optional = Object.fromEntries(
    (["returns", "repeat", "sameAs"] as const)
      .map((k) => [k, str(k)])
      .filter(([, v]) => v !== undefined),
  );
  return {
    ...optional,
    id: str("stepId") ?? `step-${l.executionOrder}`,
    from: str("from") ?? "",
    to: str("to") ?? "",
    file: l.location.physicalLocation.artifactLocation.uri,
    line: l.location.physicalLocation.region.startLine,
    caller: l.location.logicalLocations[0]?.fullyQualifiedName ?? "",
    label: l.location.message.text,
    symbol: str("symbol") ?? "",
    nesting: l.nestingLevel,
    verified: prop(p, "verified") === true,
  };
};

export function toSarif(set: FlowSet, repoUri: string): SarifLog {
  const participants = new Map<string, FlowParticipant>();
  for (const f of set.flows)
    for (const p of f.participants) participants.set(p.name, p);

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: NS,
            version: "0.1.0",
            rules: [{ id: `${NS}.flow` }],
          },
        },
        versionControlProvenance: [
          { repositoryUri: repoUri, revisionId: set.head },
        ],
        logicalLocations: [...participants.values()].map((p) => ({
          name: p.label,
          fullyQualifiedName: p.name,
          kind: "type",
          properties: props({
            external: p.external,
            component: p.component ?? null,
          }),
        })),
        results: set.flows.map((f) => ({
          ruleId: `${NS}.flow`,
          kind: "informational",
          message: { text: f.name },
          properties: props({
            flowId: f.id,
            trigger: f.trigger,
            isNew: f.isNew,
            participants: f.participants.map((p) => p.name),
          }),
          codeFlows: [
            {
              threadFlows: [
                { id: "after", locations: f.after.map(toLocation) },
                ...(f.before
                  ? [{ id: "before", locations: f.before.map(toLocation) }]
                  : []),
              ],
            },
          ],
        })),
        properties: props({
          base: set.base,
          head: set.head,
          generatedAt: set.generatedAt,
          hunks: set.hunks,
          appFiles: set.appFiles,
          costUsd: set.costUsd,
          durationMs: set.durationMs,
          model: set.model ?? null,
        }),
      },
    ],
  };
}

export function fromSarif(log: SarifLog): FlowSet {
  const run = log.runs[0];
  const p = run.properties;
  const participants = new Map<string, FlowParticipant>(
    run.logicalLocations.map((l) => [
      l.fullyQualifiedName,
      {
        name: l.fullyQualifiedName,
        label: l.name,
        external: prop(l.properties, "external") === true,
        component: (prop(l.properties, "component") as string | null) ?? null,
      },
    ]),
  );
  const flows: Flow[] = run.results.map((r) => {
    const threads = r.codeFlows[0]?.threadFlows ?? [];
    const after =
      threads.find((t) => t.id === "after")?.locations.map(fromLocation) ?? [];
    const before =
      threads.find((t) => t.id === "before")?.locations.map(fromLocation) ??
      null;
    const names =
      (prop(r.properties, "participants") as string[] | undefined) ?? [];
    return {
      id: prop(r.properties, "flowId") as string,
      name: r.message.text,
      trigger: (prop(r.properties, "trigger") as string) ?? "",
      isNew: prop(r.properties, "isNew") === true,
      participants: names.map(
        (n) =>
          participants.get(n) ?? {
            name: n,
            label: n,
            external: false,
            component: null,
          },
      ),
      before,
      after,
    };
  });
  return {
    base: (prop(p, "base") as string | null) ?? null,
    head: prop(p, "head") as string,
    generatedAt: (prop(p, "generatedAt") as number) ?? 0,
    flows,
    hunks: (prop(p, "hunks") as FlowSet["hunks"]) ?? [],
    appFiles: (prop(p, "appFiles") as string[]) ?? [],
    costUsd: (prop(p, "costUsd") as number) ?? 0,
    durationMs: (prop(p, "durationMs") as number) ?? 0,
    model: (prop(p, "model") as string | null) ?? null,
  };
}

export type { SarifLog };
