import type { DraftElement, DraftOutput } from "./prompts";

/**
 * A drafted model as DSL, in the subset `lib/dsl.ts` reads. This side owns
 * everything that would otherwise fail a parse: identifiers, strings, and
 * arrows to elements the draft doesn't have.
 */

export interface DraftIds {
  people: string[];
  externalSystems: string[];
  system: string;
  containers: { id: string; components: string[] }[];
  /** The draft's own id → the element's full hierarchical id; the first wins */
  byDraftId: Map<string, string>;
}

/**
 * Structurizr compares identifiers ignoring case, so `api` and `Api` clash
 * though the reader here would take both.
 */
function scope() {
  const taken = new Set<string>();
  return (raw: string, fallback: string) => {
    const base = raw.replace(/[^A-Za-z0-9_]/g, "_") || fallback;
    let id = base;
    for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}_${n}`;
    taken.add(id.toLowerCase());
    return id;
  };
}

export function assignIds(output: DraftOutput): DraftIds {
  const byDraftId = new Map<string, string>();
  const remember = (el: DraftElement, id: string) => {
    if (!byDraftId.has(el.id)) byDraftId.set(el.id, id);
    return id;
  };
  const top = scope();
  const people = output.people.map((p) => remember(p, top(p.id, "person")));
  const externalSystems = output.externalSystems.map((x) =>
    remember(x, top(x.id, "external")),
  );
  const system = remember(output.system, top(output.system.id, "system"));
  const inSystem = scope();
  const containers = output.system.containers.map((c) => {
    const id = remember(c, `${system}.${inSystem(c.id, "container")}`);
    const inContainer = scope();
    return {
      id,
      components: c.components.map((k) =>
        remember(k, `${id}.${inContainer(k.id, "component")}`),
      ),
    };
  });
  return { people, externalSystems, system, containers, byDraftId };
}

/**
 * A quoted DSL string: one line, `"` escaped, and no `\` at the end, where
 * it would escape the closing quote.
 */
export function quote(text: string): string {
  const flat = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s\\]+$/, "");
  return `"${flat.replace(/"/g, '\\"')}"`;
}

/** Globs are split on whitespace when read, so a space inside one becomes `?`. */
export const globList = (globs: string[]) =>
  globs
    .map((g) => g.trim().replace(/\s/g, "?"))
    .filter(Boolean)
    .join(" ");

export const isWithin = (inner: string, outer: string) =>
  inner === outer || inner.startsWith(`${outer}.`);

export function serializeModel(output: DraftOutput): string {
  const ids = assignIds(output);
  const leaf = (id: string) => id.slice(id.lastIndexOf(".") + 1);
  // The reader refuses an element with an empty name.
  const name = (el: DraftElement, id: string) => {
    const quoted = quote(el.name);
    return quoted === '""' ? quote(leaf(id)) : quoted;
  };
  const pad = (depth: number) => "    ".repeat(depth);
  const lines: string[] = [];
  const properties = (depth: number, entries: [string, string][]) => {
    const kept = entries.filter(([, value]) => value);
    if (kept.length === 0) return false;
    lines.push(`${pad(depth)}properties {`);
    for (const [key, value] of kept)
      lines.push(`${pad(depth + 1)}${quote(key)} ${quote(value)}`);
    lines.push(`${pad(depth)}}`);
    return true;
  };

  const seen = new Set<string>();
  const arrows: string[] = [];
  for (const r of output.relationships) {
    const source = ids.byDraftId.get(r.source);
    const destination = ids.byDraftId.get(r.destination);
    // Structurizr refuses an arrow between an element and its own parent.
    if (
      !source ||
      !destination ||
      isWithin(source, destination) ||
      isWithin(destination, source)
    )
      continue;
    const arrow = `${source} -> ${destination} ${quote(r.description)}`;
    if (seen.has(arrow)) continue;
    seen.add(arrow);
    arrows.push(arrow);
  }

  lines.push(
    `workspace ${quote(output.name)} ${quote(output.description)} {`,
    `${pad(1)}!identifiers hierarchical`,
    "",
  );
  if (
    properties(1, [
      ["code.tests", globList(output.tests)],
      ["code.ignore", globList(output.ignore)],
    ])
  )
    lines.push("");

  lines.push(`${pad(1)}model {`);
  output.people.forEach((p, i) =>
    lines.push(
      `${pad(2)}${ids.people[i]} = person ${name(p, ids.people[i])} ${quote(p.description)}`,
    ),
  );
  output.externalSystems.forEach((x, i) =>
    lines.push(
      `${pad(2)}${ids.externalSystems[i]} = softwareSystem ${name(x, ids.externalSystems[i])} ${quote(x.description)} "External"`,
    ),
  );
  const system = output.system;
  lines.push(
    `${pad(2)}${ids.system} = softwareSystem ${name(system, ids.system)} ${quote(system.description)} {`,
  );
  system.containers.forEach((c, i) => {
    const placed = ids.containers[i];
    lines.push(
      `${pad(3)}${leaf(placed.id)} = container ${name(c, placed.id)} ${quote(c.description)} ${quote(c.technology)} {`,
    );
    c.components.forEach((k, j) => {
      const head = `${pad(4)}${leaf(placed.components[j])} = component ${name(k, placed.components[j])} ${quote(k.description)} ${quote(k.technology)}`;
      const globs = globList(k.globs);
      if (!globs) {
        lines.push(head);
        return;
      }
      lines.push(`${head} {`);
      properties(5, [["code.globs", globs]]);
      lines.push(`${pad(4)}}`);
    });
    lines.push(`${pad(3)}}`);
  });
  lines.push(`${pad(2)}}`);
  if (arrows.length > 0) lines.push("");
  for (const arrow of arrows) lines.push(`${pad(2)}${arrow}`);
  lines.push(`${pad(1)}}`, "");

  // Only so Structurizr can open the file: Backstory skips `views`.
  const view = (kind: string, of: string) =>
    lines.push(
      `${pad(2)}${kind} ${of} {`,
      `${pad(3)}include *`,
      `${pad(3)}autoLayout`,
      `${pad(2)}}`,
    );
  lines.push(`${pad(1)}views {`);
  view("systemContext", ids.system);
  if (ids.containers.length > 0) view("container", ids.system);
  for (const c of ids.containers)
    if (c.components.length > 0) view("component", c.id);
  lines.push(`${pad(1)}}`, "}", "");
  return lines.join("\n");
}
