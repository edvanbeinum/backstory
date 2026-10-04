import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { DslError, readDsl } from "../lib/dsl";
import { buildModel, fromJson, parseDsl, type Model } from "../lib/model";

const fixture = (file: string) =>
  readFileSync(path.join(__dirname, "fixtures", file), "utf8");

const ids = (m: Model) => [...m.elements.keys()];

test("the DSL and its Structurizr export give the same model", () => {
  const dsl = parseDsl(fixture("workspace.dsl"));
  const json = buildModel(fromJson(JSON.parse(fixture("workspace.json"))));

  assert.deepEqual([...dsl.elements.values()], [...json.elements.values()]);
  assert.deepEqual(
    [...dsl.relationships.values()],
    [...json.relationships.values()],
  );
  assert.equal(dsl.elements.size, 22);
  assert.ok(dsl.relationships.size > 30);

  for (const p of [
    "ios/Shop/App.swift",
    "ios/Shop/Shop.xcdatamodeld/.xccurrentversion",
    "ios/Shop/Repositories/ProductVariant.swift",
    "ios/Shop/Repositories/HabitLearner.swift",
    "ios/Shop/Repositories/CartRepository.swift",
    "ios/Shop/Features/Cart/CartView.swift",
    "site/index.html",
    "ios/ShopTests/CartTests.swift",
    "AGENTS.md",
    "src/nowhere.ts",
  ]) {
    assert.deepEqual(dsl.match(p), json.match(p), p);
    assert.equal(dsl.isTest(p), json.isTest(p), p);
    assert.equal(dsl.isIgnored(p), json.isIgnored(p), p);
  }
  assert.deepEqual(dsl.match("ios/Shop/Shop.xcdatamodeld/.xccurrentversion"), [
    "shop.ios.shell",
  ]);
  assert.deepEqual(dsl.match("ios/Shop/Repositories/ProductVariant.swift"), [
    "shop.ios.data",
  ]);
  assert.equal(dsl.isTest("ios/ShopTests/CartTests.swift"), true);
  assert.equal(dsl.isIgnored("AGENTS.md"), true);
});

const nested = `
    model {
        s = softwareSystem "S" {
            web = container "Web" {
                api = component "API"
            }
        }
        IDREF -> s "Serves"
    }
`;

test("ids are bare by default and dotted under hierarchical", () => {
  const flat = parseDsl(`workspace {${nested.replace("IDREF", "web")}}`);
  assert.deepEqual(ids(flat), ["s", "web", "api"]);
  assert.equal(flat.elements.get("api")?.parent, "web");
  assert.ok(flat.relationships.has("web → s"));

  const dotted = parseDsl(
    `workspace {\n!identifiers hierarchical\n${nested.replace("IDREF", "s.web")}}`,
  );
  assert.deepEqual(ids(dotted), ["s", "s.web", "s.web.api"]);
  assert.equal(dotted.elements.get("s.web.api")?.parent, "s.web");
  assert.ok(dotted.relationships.has("s.web → s"));
});

test("an anonymous element gets a stable id, and its children still resolve", () => {
  const text = `workspace {
    !identifiers hierarchical
    model {
        u = person "User"
        softwareSystem "Anon" {
            web = container "Web" {
                -> api "Asks"
            }
            api = container "API"
            -> u "Notifies"
        }
        u -> web "Uses"
    }
}`;
  const model = parseDsl(text);
  assert.deepEqual(ids(model), ["u", '"Anon"', "web", "api"]);
  assert.equal(model.elements.get("web")?.parent, '"Anon"');
  assert.deepEqual(
    [...model.relationships.keys()].sort(),
    ['"Anon" → u', "u → web", "web → api"].sort(),
  );
  assert.deepEqual(ids(parseDsl(text)), ids(model));
});

test("an arrow can leave out its source, point forward, or use a short id", () => {
  const model = parseDsl(`workspace {
    !identifiers hierarchical
    model {
        u = person "U"
        u -> s.web.ui "Clicks"
        s = softwareSystem "S" {
            web = container "Web" {
                -> db "Reads"
                ui = component "UI" {
                    -> api "Calls"
                }
                api = component "API"
            }
            db = container "DB"
        }
    }
}`);
  assert.deepEqual([...model.relationships.keys()].sort(), [
    "s.web → s.db",
    "s.web.ui → s.web.api",
    "u → s.web.ui",
  ]);
});

test("comments count only at the start of a line", () => {
  const ws = readDsl(`workspace {
    # a hash comment
    // a slash comment
    /* a block comment,
       with { and } in it */
    properties {
        "colour" #999999
    }
    model {
        a = softwareSystem "A # not a comment" "see http://x.test//y" {
            properties {
                "code.globs" "src/#gen/** //odd"
            }
        }
    }
    views {
        styles {
            element "A" {
                background #999999
            }
        }
    }
}`);
  assert.equal(ws.properties.colour, "#999999");
  assert.deepEqual(ws.elements, [
    {
      id: "a",
      name: "A # not a comment",
      description: "see http://x.test//y",
      type: "softwareSystem",
      parent: null,
      properties: { "code.globs": "src/#gen/** //odd" },
    },
  ]);
});

test("escaped quotes, line continuation, and blocks that hold no elements", () => {
  const model = parseDsl(`workspace {
    configuration {
        scope softwaresystem
    }
    model {
        a = softwareSystem "Say \\"hi\\"" \\
            "Long description"  {
            properties {
                "code.globs" "src/one/** \\
                    src/two/**"
            }
        }
    }
    views {
        systemContext a "Context" {
            include *
        }
    }
}`);
  const a = model.elements.get("a");
  assert.equal(a?.name, 'Say "hi"');
  assert.equal(a?.description, "Long description");
  assert.deepEqual(a?.globs, ["src/one/**", "src/two/**"]);
  assert.deepEqual(model.match("src/two/x.ts"), ["a"]);
});

test("a tag as a system's third argument, and an extglob, are only text", () => {
  const model = parseDsl(`workspace {
    !identifiers hierarchical
    model {
        pay = softwareSystem "Pay" "Takes payments" "External"
        s = softwareSystem "S" {
            c = container "C" {
                properties {
                    "code.globs" "app/models/!(legacy_)*.rb"
                }
            }
        }
    }
}`);
  assert.equal(model.elements.get("pay")?.description, "Takes payments");
  assert.deepEqual(model.match("app/models/order.rb"), ["s.c"]);
  assert.deepEqual(model.match("app/models/legacy_order.rb"), []);
});

test("a block's description wins, and an arrow with an id and a block still counts", () => {
  const model = parseDsl(`workspace {
    model {
        a = softwareSystem "A" "Old" {
            description "New"
            tags "Internal"
            perspectives {
                "Security" "Reviewed"
            }
        }
        b = softwareSystem "B"
        r = a -> b "Calls" "HTTP" {
            tags "Async"
        }
    }
}`);
  assert.equal(model.elements.get("a")?.description, "New");
  assert.equal(model.relationships.get("a → b")?.description, "Calls");
});

const fails = (text: string, line: number, message: RegExp) =>
  assert.throws(
    () => parseDsl(text),
    (e: unknown) =>
      e instanceof DslError &&
      e.line === line &&
      message.test(e.message) &&
      e.message.includes(`line ${line}`),
  );

test("what the reader doesn't support fails on its line", () => {
  fails(
    `workspace {\n    !include other.dsl\n    model {\n    }\n}`,
    2,
    /^`!include` on line 2 isn't supported$/,
  );
  fails(
    `workspace {\n    model {\n        a = softwareSystem "A"\n        group "G" {\n            b = softwareSystem "B"\n        }\n    }\n}`,
    4,
    /^`group` on line 4 isn't supported$/,
  );
  fails(
    `workspace {\n    model {\n        a = softwareSystem "A"\n        a -> nope "Calls"\n    }\n}`,
    4,
    /no element `nope`/,
  );
  fails(
    `workspace {\n    model {\n        a = softwareSystem "A" {\n    }\n}`,
    1,
    /never closed/,
  );
  fails(
    `workspace {\n    model {\n        a = softwareSystem "A\n    }\n}`,
    3,
    /unterminated string/,
  );
  fails(`workspace extends "base.dsl" {\n}`, 1, /`workspace extends`/);
});
