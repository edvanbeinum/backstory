import {
  bundledLanguages,
  createHighlighter,
  type Highlighter,
  type ThemedToken,
} from "shiki";

import type { DiffFile } from "./types";

const LIGHT = "github-light";
const DARK = "github-dark";

/** Above this many diff lines in one request, ship plain text and stay fast. */
export const MAX_HIGHLIGHT_LINES = 8_000;

/**
 * The whole-file view is one file fetched on demand, so it can afford a higher
 * ceiling than a commit-wide diff spanning dozens of files — but not an
 * unbounded one. Dual-theme highlighting emits two CSS variables per token, so
 * cost and payload both grow fast. Measured: 1k lines ≈ 420ms / 1.1MB, 5k
 * lines ≈ 1.5s / 5.6MB, 15k lines ≈ 8.4s / 17MB. Past this cap the file still
 * renders in full, just as plain text (15k lines then takes ~100ms), and the
 * UI says why.
 */
export const MAX_HIGHLIGHT_LINES_SINGLE_FILE = 5_000;

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT, DARK],
      langs: [],
    });
  }
  return highlighterPromise;
}

async function ensureLang(lang: string): Promise<boolean> {
  if (loadedLangs.has(lang)) return true;
  if (!(lang in bundledLanguages)) return false;

  try {
    const highlighter = await getHighlighter();
    await highlighter.loadLanguage(lang as keyof typeof bundledLanguages);
    loadedLangs.add(lang);
    return true;
  } catch {
    return false;
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function tokensToHtml(tokens: ThemedToken[]): string {
  let html = "";
  for (const token of tokens) {
    const style = token.htmlStyle;
    let css: string;

    if (typeof style === "string") {
      css = style;
    } else if (style && typeof style === "object") {
      css = Object.entries(style)
        .map(([k, v]) => `${k}:${v}`)
        .join(";");
    } else {
      css = token.color ? `color:${token.color}` : "";
    }

    html += css
      ? `<span style="${css}">${escapeHtml(token.content)}</span>`
      : escapeHtml(token.content);
  }
  return html;
}

/**
 * Attach per-line HTML to every line of every file.
 *
 * Each file is highlighted as two whole blocks — the old-side sequence and the
 * new-side sequence — rather than line by line. Tokenising a line in isolation
 * loses all cross-line context, so multi-line strings, block comments and
 * heredocs come out wrong; feeding a contiguous run of lines keeps the
 * grammar state coherent. Hunks skip regions of the file, so this still isn't
 * perfect, but it's right for everything inside a hunk.
 */
export async function highlightFiles(
  files: DiffFile[],
  maxLines: number = MAX_HIGHLIGHT_LINES,
): Promise<boolean> {
  const totalLines = files.reduce(
    (n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0),
    0,
  );

  if (totalLines > maxLines) {
    plainText(files);
    return false;
  }

  for (const file of files) {
    if (file.isBinary || file.hunks.length === 0) continue;

    const lang = file.lang;
    const usable = lang ? await ensureLang(lang) : false;
    if (!usable || !lang) {
      plainTextFile(file);
      continue;
    }

    // Collect the two sides. Context lines belong to both.
    const oldRefs: Array<{ hunk: number; line: number }> = [];
    const newRefs: Array<{ hunk: number; line: number }> = [];
    const oldSrc: string[] = [];
    const newSrc: string[] = [];

    file.hunks.forEach((hunk, hi) => {
      hunk.lines.forEach((line, li) => {
        if (line.type !== "add") {
          oldRefs.push({ hunk: hi, line: li });
          oldSrc.push(line.content);
        }
        if (line.type !== "del") {
          newRefs.push({ hunk: hi, line: li });
          newSrc.push(line.content);
        }
      });
    });

    const highlighter = await getHighlighter();

    const renderSide = (src: string[]) => {
      if (src.length === 0) return [] as string[];
      try {
        const { tokens } = highlighter.codeToTokens(src.join("\n"), {
          // ensureLang has already checked this against bundledLanguages
          lang: lang as keyof typeof bundledLanguages,
          themes: { light: LIGHT, dark: DARK },
          defaultColor: false,
        });
        return tokens.map(tokensToHtml);
      } catch {
        return src.map(escapeHtml);
      }
    };

    const oldHtml = renderSide(oldSrc);
    const newHtml = renderSide(newSrc);

    // The new side wins for context lines: it's what the code looks like now.
    oldRefs.forEach((ref, i) => {
      const line = file.hunks[ref.hunk].lines[ref.line];
      if (line.type === "del")
        line.html = oldHtml[i] ?? escapeHtml(line.content);
    });
    newRefs.forEach((ref, i) => {
      const line = file.hunks[ref.hunk].lines[ref.line];
      line.html = newHtml[i] ?? escapeHtml(line.content);
    });

    // Anything the two passes missed (shouldn't happen) falls back to plain.
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.html === undefined) line.html = escapeHtml(line.content);
      }
    }
  }

  return true;
}

function plainText(files: DiffFile[]) {
  for (const file of files) plainTextFile(file);
}

function plainTextFile(file: DiffFile) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      line.html = escapeHtml(line.content);
    }
  }
}

/**
 * Highlight a raw diff hunk from a GitHub review comment. These arrive as a
 * unified-diff string and are shown as the comment's context, exactly the way
 * GitHub renders them above a thread.
 */
export function renderDiffHunk(hunk: string): Array<{
  type: "add" | "del" | "context" | "header";
  content: string;
}> {
  return hunk.split("\n").map((line) => {
    if (line.startsWith("@@"))
      return { type: "header" as const, content: line };
    if (line.startsWith("+"))
      return { type: "add" as const, content: line.slice(1) };
    if (line.startsWith("-"))
      return { type: "del" as const, content: line.slice(1) };
    return { type: "context" as const, content: line.replace(/^ /, "") };
  });
}
