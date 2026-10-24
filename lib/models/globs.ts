import { isAppCode, parseDsl } from "../model";

interface GlobCheck {
  unmatched: string[];
  ambiguous: { file: string; ids: string[] }[];
}

/**
 * The app files a model's components leave out, or claim twice. Reads the
 * DSL back through the map's own reader, so it sees what the map will.
 */
export function checkGlobs(dsl: string, files: string[]): GlobCheck {
  const model = parseDsl(dsl);
  const unmatched: string[] = [];
  const ambiguous: GlobCheck["ambiguous"] = [];
  for (const file of files) {
    if (!isAppCode(model, file)) continue;
    const ids = model.match(file);
    if (ids.length === 0) unmatched.push(file);
    else if (ids.length > 1) ambiguous.push({ file, ids });
  }
  return { unmatched, ambiguous };
}
