/**
 * Map a path to a Shiki language id. Kept separate from highlight.ts so the
 * diff parser stays pure (no shiki import) and testable.
 */

const BY_EXTENSION: Record<string, string | null> = {
  swift: "swift",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  erb: "erb",
  haml: "haml",
  slim: "slim",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "fish",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  storyboard: "xml",
  xib: "xml",
  entitlements: "xml",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  styl: "stylus",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  md: "markdown",
  mdx: "mdx",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "dotenv",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  lua: "lua",
  pl: "perl",
  r: "r",
  jl: "julia",
  zig: "zig",
  nim: "nim",
  vim: "viml",
  tf: "terraform",
  hcl: "hcl",
  gradle: "groovy",
  groovy: "groovy",
  bat: "bat",
  cmd: "bat",
  diff: "diff",
  patch: "diff",
  // Xcode project files are enormous and machine-generated; highlighting them
  // costs a lot and buys nothing.
  pbxproj: null,
};

const BY_FILENAME: Record<string, string | null> = {
  dockerfile: "docker",
  makefile: "make",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  fastfile: "ruby",
  appfile: "ruby",
  brewfile: "ruby",
  ".gitignore": "gitignore",
  ".gitattributes": "properties",
  ".editorconfig": "ini",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".prettierrc": "json",
  ".npmrc": "ini",
  ".nvmrc": "text",
};

export function langForPath(path: string | null): string | null {
  if (!path) return null;

  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();

  const byName = BY_FILENAME[lower];
  if (byName !== undefined) return byName || null;

  // Dockerfile.web, Makefile.local, …
  for (const [name, lang] of Object.entries(BY_FILENAME)) {
    if (!name.startsWith(".") && lower.startsWith(`${name}.`)) return lang;
  }

  const dot = lower.lastIndexOf(".");
  if (dot === -1 || dot === lower.length - 1) return null;

  const ext = lower.slice(dot + 1);
  return BY_EXTENSION[ext] ?? null;
}
