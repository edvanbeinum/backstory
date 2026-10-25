// Build the site's demo into site/demo: the app's page bundled with
// demo/main.tsx, the app's stylesheet run through Tailwind, and the recording.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

import tailwind from "@tailwindcss/postcss";
import { build } from "esbuild";
import postcss from "postcss";

const out = "site/demo";

await build({
  entryPoints: ["demo/main.tsx"],
  outfile: `${out}/app.js`,
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

const css = "app/globals.css";
const { css: built } = await postcss([tailwind()]).process(
  readFileSync(css, "utf8"),
  {
    from: css,
  },
);
writeFileSync(`${out}/app.css`, built);

copyFileSync("demo/pr-117.json", `${out}/recording.json`);
