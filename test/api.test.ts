import assert from "node:assert/strict";
import { test } from "node:test";

import { crossSite } from "../lib/api";

const req = (headers: Record<string, string>) =>
  new Request("http://127.0.0.1:4460/api/flows", { method: "POST", headers: { host: "127.0.0.1:4460", ...headers } });

test("differ's own page and the CLI may POST; another site's page may not", () => {
  assert.equal(crossSite(req({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4460" })), null);
  assert.equal(crossSite(req({})), null);
  assert.equal(crossSite(req({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }))?.status, 403);
  assert.equal(crossSite(req({ origin: "https://evil.example" }))?.status, 403);
});
