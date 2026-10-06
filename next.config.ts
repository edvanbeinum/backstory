import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output bundles the server and its traced node_modules into
  // .next/standalone, so Homebrew (and the launchd service) can run differ
  // with plain `node server.js` — no repo checkout, no `npm install`.
  output: "standalone",
  // Shiki loads grammars dynamically at request time; keeping it external
  // makes Next copy the whole package into the standalone trace instead of
  // trying (and failing) to statically bundle the per-language JSON.
  serverExternalPackages: ["shiki"],
  // `lib/exec.ts` makes Next trace the whole project, which would copy the
  // Mac app's sources and its Xcode build output into the server.
  outputFileTracingExcludes: { "/*": ["./mac/**/*"] },
};

export default nextConfig;
