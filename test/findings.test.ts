import assert from "node:assert/strict";
import { test } from "node:test";

import type { DataResponse } from "../lib/data/types";
import { findings } from "../lib/findings";
import type { Flow, FlowSet, FlowStep } from "../lib/flows/types";

let n = 0;
const step = (
  from: string,
  to: string,
  label: string,
  site = `f${++n}.rb:1`,
): FlowStep => {
  const [file, line] = site.split(":");
  return {
    id: `s${++n}`,
    from,
    to,
    file,
    line: Number(line),
    caller: from,
    label,
    symbol: label,
    nesting: 0,
    verified: true,
  };
};

const flow = (
  name: string,
  after: FlowStep[],
  external: string[] = [],
): Flow => {
  const names = [...new Set(after.flatMap((s) => [s.from, s.to]))];
  return {
    id: name.toLowerCase().replace(/\W+/g, "-"),
    name,
    trigger: name,
    isNew: true,
    participants: names.map((p) => ({
      name: p,
      label: p,
      external: external.includes(p),
    })),
    before: null,
    after,
  };
};

const set = (flows: Flow[]): FlowSet => ({
  base: "b",
  head: "h",
  generatedAt: 0,
  flows,
  hunks: [],
  appFiles: [],
  costUsd: 0,
  durationMs: 0,
});

const kinds = (f: ReturnType<typeof findings>) => f.map((x) => x.kind);

test("a core entity gaining a vendor's fields is noted, on that entity", () => {
  const data: DataResponse = {
    status: "ok",
    baseModel: true,
    entities: [
      {
        name: "Item",
        state: "changed",
        file: "app/models/item.rb",
        component: "Catalog",
        fields: [
          {
            state: "same",
            item: { name: "title", type: "string", required: true },
          },
          {
            state: "added",
            item: {
              name: "zoom_meeting_uuid",
              type: "string",
              required: false,
            },
          },
        ],
        relationships: [],
        constraints: [],
      },
    ],
  };
  const flows = set([
    flow("Import", [
      step("Controller", "ZoomClient", "ZoomClient.new.recordings"),
    ]),
  ]);
  const found = findings(flows, data);
  assert.deepEqual(kinds(found), ["vendor-fields"]);
  assert.equal(found[0].title, "Item (Catalog) gains 1 Zoom field");
  assert.deepEqual(found[0].on, { entity: "Item" });
});

test("raw HTTP beside a vendor client is noted; HTTP inside the client isn't", () => {
  const picker = flow("Picker", [
    step("Controller", "ZoomClient", "ZoomClient.new.recordings"),
  ]);
  const leaky = flow(
    "Job",
    [step("ImportZoomRecordingJob", "Net::HTTP", "Net::HTTP.start")],
    ["Net::HTTP"],
  );
  assert.deepEqual(kinds(findings(set([picker, leaky]), null)), ["two-ways"]);
  const owned = flow(
    "Job",
    [step("ZoomClient", "Net::HTTP", "http.request")],
    ["Net::HTTP"],
  );
  assert.deepEqual(kinds(findings(set([picker, owned]), null)), []);
});

test("raw HTTP is credited only to the vendor it names", () => {
  const clients = flow("Pay", [
    step("Controller", "ZoomClient", "ZoomClient.new.recordings"),
    step("Controller", "StripeClient", "StripeClient.charge"),
  ]);
  const slack = flow(
    "Notify",
    [step("NotifyJob", "Net::HTTP", "Net::HTTP.post(webhook_url)")],
    ["Net::HTTP"],
  );
  assert.deepEqual(kinds(findings(set([clients, slack]), null)), []);
  const zoom = flow(
    "Import",
    [step("ImportZoomRecordingJob", "NetHTTP", "http.request")],
    ["NetHTTP"],
  );
  const found = findings(set([clients, slack, zoom]), null);
  assert.deepEqual(
    found.map((f) => f.id),
    ["two-ways:Zoom"],
  );
  assert.equal(found[0].evidence.length, 1);
});

test("a lane only starting like an HTTP library isn't raw HTTP", () => {
  const picker = flow("Picker", [
    step("Controller", "ZoomClient", "ZoomClient.new.recordings"),
  ]);
  const named = flow("Zoom", [
    step("ZoomWebhook", "RequestsController", "zoom requests"),
    step("ZoomWebhook", "Fetcher", "zoom fetch"),
  ]);
  assert.deepEqual(kinds(findings(set([picker, named]), null)), []);
});

test("two flows making the same calls from different code are noted; from the same code they aren't", () => {
  const calls = (from: string, sites: string[]) => [
    step(from, "ZoomClient", "ZoomClient.new(account).recordings", sites[0]),
    step(from, "Recording", "recording.selectable?", sites[1]),
    step(from, "ImportJob", "ImportJob.perform_later(item)", sites[2]),
  ];
  const copied = set([
    flow("Import", calls("PickerController", ["a.rb:1", "a.rb:2", "a.rb:3"])),
    flow("Retry", calls("RetryController", ["b.rb:1", "b.rb:2", "b.rb:3"])),
  ]);
  const [note] = findings(copied, null);
  assert.equal(note.kind, "repeated-flows");
  assert.deepEqual(note.on, { flows: [0, 1] });
  // Two ways into one screen reach the same lines: shared, not copied.
  const shared = set([
    flow(
      "From Exercise",
      calls("ProgressView", ["v.rb:1", "v.rb:2", "v.rb:3"]),
    ),
    flow("From History", calls("ProgressView", ["v.rb:1", "v.rb:2", "v.rb:3"])),
  ]);
  assert.deepEqual(kinds(findings(shared, null)), []);
});
