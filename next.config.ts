import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output bundles the server and its traced node_modules into
  // .next/standalone, so the Mac app can run differ with plain
  // `node server.js` from its bundle — no repo checkout, no `npm install`.
  output: "standalone",
  // Shiki loads grammars dynamically at request time; keeping it external
  // makes Next copy the whole package into the standalone trace instead of
  // trying (and failing) to statically bundle the per-language JSON.
  serverExternalPackages: ["shiki"],
  // Turn off image optimization, so the server never loads sharp and the Mac
  // app can leave it out of its bundle (`mac/build.sh`): differ doesn't use
  // `next/image`. Next's own server trace still lists sharp, which route
  // excludes can't reach.
  images: { unoptimized: true },
  // `lib/exec.ts` makes Next trace the whole project, which would copy the
  // Mac app's sources and its Xcode build output into the server.
  outputFileTracingExcludes: { "/*": ["./mac/**/*"] },
};

export default nextConfig;
