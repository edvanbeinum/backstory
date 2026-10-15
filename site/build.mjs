#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFile(path.join(dir, file), "utf8");

const escape = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const styles = (text) =>
  text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\*([^*]+)\*|(?<!\w)_([^_]+)_(?!\w)/g,
      (_, a, b) => `<em>${a ?? b}</em>`,
    );

// Style the text around [text](url) links but not their URLs, where an
// underscore would otherwise turn into emphasis.
const inline = (text) =>
  escape(text)
    .split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/)
    .map((part) => {
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      return link
        ? `<a href="${link[2]}">${styles(link[1])}</a>`
        : styles(part);
    })
    .join("");

/** Lines joined into one, where a line ending in two spaces breaks the line. */
const lines = (para) =>
  para
    .split(/ {2,}\n/)
    .map((line) => inline(line.replace(/\s+/g, " ").trim()))
    .join("<br />");

/**
 * A text section as HTML. Plain text keeps markdown's breaks, with a blank line
 * starting a new paragraph. Text with a "- " list in it becomes <p> and <ul>
 * blocks, so its slot in the template has to be a <div>, not a <p>.
 */
function render(text) {
  const blocks = [];
  for (const raw of text.trim().split("\n")) {
    const line = raw.trim();
    const last = blocks.at(-1);
    if (line.startsWith("- ")) blocks.push({ item: line.slice(2) });
    else if (line === "") blocks.push({ gap: true });
    else if (last?.text) last.text.push(raw);
    else blocks.push({ text: [raw] });
  }
  const paras = blocks
    .filter((b) => b.text)
    .map((b) => lines(b.text.join("\n")));
  if (!blocks.some((b) => b.item)) return paras.join("<br /><br />");

  let html = "";
  for (const [i, b] of blocks.entries()) {
    if (b.text) html += `<p>${lines(b.text.join("\n"))}</p>`;
    if (!b.item) continue;
    if (!blocks[i - 1]?.item) html += "<ul>";
    html += `<li>${inline(b.item)}</li>`;
    if (!blocks[i + 1]?.item) html += "</ul>";
  }
  return { block: html };
}

/** Each `## key` section of copy.md: a string, or a list when every line starts "- ". */
function parseCopy(markdown) {
  const copy = new Map();
  for (const section of markdown.split(/^## /m).slice(1)) {
    const [key, ...rest] = section.split("\n");
    const lines = rest.map((line) => line.trim()).filter(Boolean);
    const isList =
      lines.length > 0 && lines.every((line) => line.startsWith("- "));
    copy.set(
      key.trim(),
      isList
        ? lines.map((line) => inline(line.slice(2)))
        : render(rest.join("\n")),
    );
  }
  return copy;
}

const copy = parseCopy(await read("copy.md"));
const used = new Set();
const errors = [];

function lookup(key, kind) {
  used.add(key);
  const value = copy.get(key);
  if (value === undefined) errors.push(`no "## ${key}" in copy.md`);
  else if (kind === "list" && !Array.isArray(value))
    errors.push(`"## ${key}" needs to be a list of "- " lines`);
  else if (kind === "text" && Array.isArray(value))
    errors.push(`"## ${key}" is a list, but the template wants one line`);
  else if (kind === "text" && typeof value === "object") {
    if (new RegExp(`<p[^>]*>\\s*{{${key}}}\\s*</p>`).test(template))
      errors.push(
        `"## ${key}" has a list in it, but its slot in template.html is a <p>`,
      );
    return value.block;
  } else return value;
  return kind === "list" ? [] : "";
}

const template = await read("template.html");
const filled = template
  .replace(/{{#([\w.]+)}}([\s\S]*?){{\/\1}}/g, (_, key, body) =>
    lookup(key, "list")
      .map((item, i) =>
        body.replace(/{{\.}}/g, item).replace(/{{n}}/g, String(i + 1)),
      )
      .join(""),
  )
  .replace(/{{len ([\w.]+)}}/g, (_, key) => String(lookup(key, "list").length))
  .replace(/{{([\w.]+)}}/g, (_, key) => lookup(key, "text"));

for (const key of copy.keys())
  if (!used.has(key)) errors.push(`"## ${key}" isn't used by template.html`);
if (errors.length > 0) {
  console.error([...new Set(errors)].map((e) => `copy.md: ${e}`).join("\n"));
  process.exit(1);
}

// Inline every image, the favicons too, as a data URI, because the artifact
// viewer serves the page where its relative img/ paths don't resolve, and
// Pages publishes only index.html.
const types = { png: "image/png", svg: "image/svg+xml" };
const asset = /(src|href)="(img\/[\w/-]+\.(png|svg))"/g;
const sources = [...new Set([...filled.matchAll(asset)].map((m) => m[2]))];
const images = new Map(
  await Promise.all(
    sources.map(async (src) => [
      src,
      (await readFile(path.join(dir, src))).toString("base64"),
    ]),
  ),
);
const out = filled.replace(
  asset,
  (_, attr, src, ext) =>
    `${attr}="data:${types[ext]};base64,${images.get(src)}"`,
);

await mkdir(path.join(dir, "dist"), { recursive: true });
const target = path.join(dir, "dist", "index.html");
await writeFile(target, out);
console.log(
  `${path.relative(process.cwd(), target)} · ${copy.size} copy sections · ${images.size} images inlined`,
);
