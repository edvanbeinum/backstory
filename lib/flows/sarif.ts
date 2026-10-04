import type { Flow, FlowParticipant, FlowSet, FlowStep } from "./types";

/**
 * The cache is SARIF 2.1.0: one informational result per flow, its steps as
 * `codeFlows` thread flows ("after" at the head, "before" at the base).
 * Whatever SARIF has no field for goes in `differ.*` properties.
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
  properties: Object.fromEntries(
    Object.entries({
      "differ.stepId": s.id,
      "differ.from": s.from,
      "differ.to": s.to,
      "differ.symbol": s.symbol,
      "differ.returns": s.returns,
      "differ.repeat": s.repeat,
      "differ.sameAs": s.sameAs,
      "differ.verified": s.verified,
    }).filter(([, v]) => v !== undefined && v !== ""),
  ),
});

const fromLocation = (l: SarifLocation): FlowStep => {
  const p = l.properties;
  const str = (key: string) =>
    typeof p[key] === "string" ? (p[key] as string) : undefined;
  const optional = Object.fromEntries(
    (["returns", "repeat", "sameAs"] as const)
      .map((k) => [k, str(`differ.${k}`)])
      .filter(([, v]) => v !== undefined),
  );
  return {
    ...optional,
    id: str("differ.stepId") ?? `step-${l.executionOrder}`,
    from: str("differ.from") ?? "",
    to: str("differ.to") ?? "",
    file: l.location.physicalLocation.artifactLocation.uri,
    line: l.location.physicalLocation.region.startLine,
    caller: l.location.logicalLocations[0]?.fullyQualifiedName ?? "",
    label: l.location.message.text,
    symbol: str("differ.symbol") ?? "",
    nesting: l.nestingLevel,
    verified: p["differ.verified"] === true,
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
            name: "differ",
            version: "0.1.0",
            rules: [{ id: "differ.flow" }],
          },
        },
        versionControlProvenance: [
          { repositoryUri: repoUri, revisionId: set.head },
        ],
        logicalLocations: [...participants.values()].map((p) => ({
          name: p.label,
          fullyQualifiedName: p.name,
          kind: "type",
          properties: {
            "differ.external": p.external,
            "differ.component": p.component ?? null,
          },
        })),
        results: set.flows.map((f) => ({
          ruleId: "differ.flow",
          kind: "informational",
          message: { text: f.name },
          properties: {
            "differ.flowId": f.id,
            "differ.trigger": f.trigger,
            "differ.isNew": f.isNew,
            "differ.participants": f.participants.map((p) => p.name),
          },
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
        properties: {
          "differ.base": set.base,
          "differ.head": set.head,
          "differ.generatedAt": set.generatedAt,
          "differ.hunks": set.hunks,
          "differ.appFiles": set.appFiles,
          "differ.costUsd": set.costUsd,
          "differ.durationMs": set.durationMs,
          "differ.model": set.model ?? null,
        },
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
        external: l.properties["differ.external"] === true,
        component: (l.properties["differ.component"] as string | null) ?? null,
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
      (r.properties["differ.participants"] as string[] | undefined) ?? [];
    return {
      id: r.properties["differ.flowId"] as string,
      name: r.message.text,
      trigger: (r.properties["differ.trigger"] as string) ?? "",
      isNew: r.properties["differ.isNew"] === true,
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
    base: (p["differ.base"] as string | null) ?? null,
    head: p["differ.head"] as string,
    generatedAt: (p["differ.generatedAt"] as number) ?? 0,
    flows,
    hunks: (p["differ.hunks"] as FlowSet["hunks"]) ?? [],
    appFiles: (p["differ.appFiles"] as string[]) ?? [],
    costUsd: (p["differ.costUsd"] as number) ?? 0,
    durationMs: (p["differ.durationMs"] as number) ?? 0,
    model: (p["differ.model"] as string | null) ?? null,
  };
}

export type { SarifLog };
