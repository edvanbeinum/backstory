import type {
  ElementType,
  Workspace,
  WorkspaceElement,
  WorkspaceRelationship,
} from "./model";

/**
 * A reader for the part of the Structurizr DSL that differ's models use:
 * people, software systems, containers and components, their properties, and
 * the arrows between them. Anything that could hold elements it doesn't read
 * (`group`, `!include`, `deploymentEnvironment`, …) fails the parse rather
 * than being skipped, since a model missing those elements would show wrong
 * neighbours and call mapped files unmapped. Blocks at the workspace's top
 * level that hold no elements (`views`, `styles`, `configuration`) are skipped.
 */

export class DslError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = "DslError";
  }
}

type Token =
  | { kind: "word" | "string"; text: string; line: number }
  | { kind: "open" | "close" | "eol"; text: string; line: number };

const isSpace = (c: string) => c === " " || c === "\t" || c === "\r";

/** A `\` at the end of a line joins the next one to it. */
function continuation(text: string, i: number): number | null {
  if (text[i] !== "\\") return null;
  let j = i + 1;
  if (text[j] === "\r") j++;
  return text[j] === "\n" ? j + 1 : null;
}

function skipIndent(text: string, i: number): number {
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let lineStart = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const joined = continuation(text, i);
    if (joined !== null) {
      line++;
      i = skipIndent(text, joined);
      continue;
    }
    if (c === "\n") {
      tokens.push({ kind: "eol", text: "\n", line });
      line++;
      i++;
      lineStart = true;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }
    // Structurizr only takes these as comments at the start of a line, which
    // keeps `background #999999` and a URL's `//` out of them.
    if (lineStart && (c === "#" || text.startsWith("//", i))) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (lineStart && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new DslError(`unclosed comment on line ${line}`, line);
      for (let j = i; j < end; j++) if (text[j] === "\n") line++;
      i = end + 2;
      continue;
    }
    lineStart = false;
    if (c === '"') {
      const start = line;
      let value = "";
      i++;
      for (;;) {
        if (i >= text.length || text[i] === "\n")
          throw new DslError(`unterminated string on line ${start}`, start);
        const joinedHere = continuation(text, i);
        if (joinedHere !== null) {
          line++;
          i = skipIndent(text, joinedHere);
        } else if (text[i] === "\\" && text[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (text[i] === '"') {
          i++;
          break;
        } else {
          value += text[i++];
        }
      }
      tokens.push({ kind: "string", text: value, line: start });
      continue;
    }
    const start = line;
    let word = "";
    while (i < text.length && text[i] !== "\n" && !isSpace(text[i])) {
      const joinedHere = continuation(text, i);
      if (joinedHere !== null) {
        line++;
        i = skipIndent(text, joinedHere);
        continue;
      }
      word += text[i++];
    }
    const kind = word === "{" ? "open" : word === "}" ? "close" : "word";
    tokens.push({ kind, text: word, line: start });
  }
  return tokens;
}

interface Statement {
  tokens: Token[];
  line: number;
  /** It ends in `{`, which has been read: its body follows */
  block: boolean;
}

interface Scope {
  element: WorkspaceElement;
  /** What the children's hierarchical ids start with */
  prefix: string;
}

interface PendingRelationship {
  source: string;
  /** The source was written out, so it still needs resolving */
  sourceWritten: boolean;
  destination: string;
  description: string;
  line: number;
  /** Prefixes to resolve a short id against, innermost first */
  prefixes: string[];
}

const ELEMENT_PARENT: Record<ElementType, ElementType | null> = {
  person: null,
  softwareSystem: null,
  container: "softwareSystem",
  component: "container",
};

const isElementType = (word: string): word is ElementType =>
  Object.prototype.hasOwnProperty.call(ELEMENT_PARENT, word);

const unsupported = (t: Token) =>
  new DslError(`\`${t.text}\` on line ${t.line} isn't supported`, t.line);

export function readDsl(text: string): Workspace {
  const tokens = tokenize(text);
  let pos = 0;

  const next = (): Statement | "close" | null => {
    while (tokens[pos]?.kind === "eol") pos++;
    const first = tokens[pos];
    if (!first) return null;
    if (first.kind === "close") {
      pos++;
      return "close";
    }
    const out: Token[] = [];
    for (;;) {
      const t = tokens[pos];
      if (!t || t.kind === "eol" || t.kind === "close") {
        return { tokens: out, line: first.line, block: false };
      }
      pos++;
      if (t.kind === "open") {
        return { tokens: out, line: first.line, block: true };
      }
      out.push(t);
    }
  };

  const body = (opened: number, onStatement: (s: Statement) => void) => {
    for (;;) {
      const s = next();
      if (s === null)
        throw new DslError(
          `the \`{\` on line ${opened} is never closed`,
          opened,
        );
      if (s === "close") return;
      if (s.tokens.length === 0)
        throw new DslError(`a \`{\` on line ${s.line} opens nothing`, s.line);
      onStatement(s);
    }
  };

  const skip = (opened: number) => body(opened, (s) => s.block && skip(s.line));

  const readProperties = (opened: number, into: Record<string, string>) =>
    body(opened, (s) => {
      if (s.block) throw unsupported(s.tokens[0]);
      into[s.tokens[0].text] = s.tokens[1]?.text ?? "";
    });

  let hierarchical = false;
  const properties: Record<string, string> = {};
  const elements: WorkspaceElement[] = [];
  const definedAt = new Map<string, number>();
  const pending: PendingRelationship[] = [];
  const anonymous = new Map<string, number>();

  const identifiers = (s: Statement) => {
    const mode = s.tokens[1]?.text;
    if (s.block || (mode !== "hierarchical" && mode !== "flat"))
      throw unsupported(s.tokens[0]);
    hierarchical = mode === "hierarchical";
  };

  const prefixesOf = (scopes: Scope[]) =>
    scopes
      .map((sc) => sc.prefix)
      .filter(Boolean)
      .reverse();

  const relationship = (
    s: Statement,
    rest: Token[],
    scopes: Scope[],
  ): boolean => {
    const arrow = rest.findIndex((t) => t.kind === "word" && t.text === "->");
    if (arrow !== 0 && arrow !== 1) return false;
    const scope = scopes[scopes.length - 1];
    if (arrow === 0 && !scope)
      throw new DslError(
        `the arrow on line ${s.line} has no source: only an element's block can leave it out`,
        s.line,
      );
    const destination = rest[arrow + 1];
    if (!destination)
      throw new DslError(
        `the arrow on line ${s.line} has no destination`,
        s.line,
      );
    pending.push({
      source: arrow === 0 ? scope.element.id : rest[0].text,
      sourceWritten: arrow === 1,
      destination: destination.text,
      description: rest[arrow + 2]?.text ?? "",
      line: s.line,
      prefixes: prefixesOf(scopes),
    });
    if (s.block) skip(s.line);
    return true;
  };

  const element = (
    s: Statement,
    head: Token,
    type: ElementType,
    identifier: string | null,
    scopes: Scope[],
  ) => {
    const scope = scopes[scopes.length - 1];
    const parentType = scope?.element.type ?? null;
    if (ELEMENT_PARENT[type] !== parentType) {
      const where = ELEMENT_PARENT[type]
        ? `has to be inside a \`${ELEMENT_PARENT[type]}\``
        : `can't be inside a \`${parentType}\``;
      throw new DslError(`\`${type}\` on line ${s.line} ${where}`, s.line);
    }
    const args = s.tokens.slice(s.tokens.indexOf(head) + 1);
    const name = args[0]?.text;
    if (!name)
      throw new DslError(`\`${type}\` on line ${s.line} needs a name`, s.line);
    const prefix = scope?.prefix ?? "";
    let id: string;
    if (identifier) {
      id = hierarchical && prefix ? `${prefix}.${identifier}` : identifier;
    } else {
      // Quoted, so it can't clash with a DSL identifier; named, so it stays
      // put when elements are added before it.
      const base = `${prefix ? `${prefix}.` : ""}"${name}"`;
      const seen = (anonymous.get(base) ?? 0) + 1;
      anonymous.set(base, seen);
      id = seen === 1 ? base : `${base}#${seen}`;
    }
    const earlier = definedAt.get(id);
    if (earlier !== undefined)
      throw new DslError(
        `\`${identifier ?? name}\` on line ${s.line} is already defined on line ${earlier}`,
        s.line,
      );
    definedAt.set(id, s.line);
    const el: WorkspaceElement = {
      id,
      name,
      description: args[1]?.text ?? "",
      type,
      parent: scope?.element.id ?? null,
      properties: {},
    };
    elements.push(el);
    if (s.block) {
      // An anonymous element adds nothing to its children's ids, so a child
      // is still named from the nearest element that has an identifier.
      const inner = { element: el, prefix: identifier ? id : prefix };
      body(s.line, (child) => modelStatement(child, [...scopes, inner]));
    }
  };

  const modelStatement = (s: Statement, scopes: Scope[]) => {
    const first = s.tokens[0];
    const scope = scopes[scopes.length - 1];
    if (first.kind === "word" && first.text.startsWith("!")) {
      if (first.text === "!identifiers" && !scope) return identifiers(s);
      throw unsupported(first);
    }
    let identifier: string | null = null;
    let rest = s.tokens;
    if (s.tokens[1]?.kind === "word" && s.tokens[1].text === "=") {
      if (first.kind !== "word") throw unsupported(first);
      identifier = first.text;
      rest = s.tokens.slice(2);
      if (rest.length === 0)
        throw new DslError(
          `\`${identifier} =\` on line ${s.line} names nothing`,
          s.line,
        );
    }
    if (relationship(s, rest, scopes)) return;
    const head = rest[0];
    if (head.kind === "word" && isElementType(head.text))
      return element(s, head, head.text, identifier, scopes);
    if (scope && !identifier && head.kind === "word") {
      switch (head.text) {
        case "tags":
        case "technology":
        case "url":
          if (!s.block) return;
          break;
        case "description":
          if (s.block) break;
          scope.element.description = rest[1]?.text ?? "";
          return;
        case "properties":
          if (!s.block) break;
          return readProperties(s.line, scope.element.properties);
        case "perspectives":
          if (!s.block) break;
          return skip(s.line);
      }
    }
    throw unsupported(head);
  };

  const workspaceStatement = (s: Statement) => {
    const first = s.tokens[0];
    if (first.kind === "word" && first.text.startsWith("!")) {
      if (first.text === "!identifiers") return identifiers(s);
      throw unsupported(first);
    }
    if (!s.block) return;
    if (first.text === "model")
      return body(s.line, (m) => modelStatement(m, []));
    if (first.text === "properties") return readProperties(s.line, properties);
    skip(s.line);
  };

  const opening = next();
  if (opening === null) throw new DslError("there's no `workspace` block", 1);
  if (opening === "close") throw new DslError("unexpected `}` on line 1", 1);
  const [keyword, extendsWord] = opening.tokens;
  if (keyword?.text !== "workspace") throw unsupported(keyword);
  if (extendsWord?.kind === "word" && extendsWord.text === "extends")
    throw new DslError(
      `\`workspace extends\` on line ${opening.line} isn't supported`,
      opening.line,
    );
  if (!opening.block)
    throw new DslError(
      `\`workspace\` on line ${opening.line} needs a \`{\``,
      opening.line,
    );
  body(opening.line, workspaceStatement);
  while (tokens[pos]?.kind === "eol") pos++;
  const trailing = tokens[pos];
  if (trailing)
    throw new DslError(
      `unexpected \`${trailing.text}\` on line ${trailing.line}, after the workspace`,
      trailing.line,
    );

  const resolve = (id: string, prefixes: string[], line: number) => {
    if (definedAt.has(id)) return id;
    for (const p of prefixes) {
      if (definedAt.has(`${p}.${id}`)) return `${p}.${id}`;
    }
    throw new DslError(
      `no element \`${id}\` for the arrow on line ${line}`,
      line,
    );
  };
  const relationships: WorkspaceRelationship[] = pending.map((r) => ({
    source: r.sourceWritten ? resolve(r.source, r.prefixes, r.line) : r.source,
    destination: resolve(r.destination, r.prefixes, r.line),
    description: r.description,
  }));

  // Structurizr's export lists people before software systems, wherever
  // they're written; keeping its order keeps cached flows keyed the same.
  return {
    properties,
    elements: [
      ...elements.filter((e) => e.type === "person"),
      ...elements.filter((e) => e.type !== "person"),
    ],
    relationships,
  };
}
