// SPDX-License-Identifier: MIT
// implements XSPEC-514
import { describe, it, expect } from "vitest";

import { extractProjectDetailed } from "../src/code-graph/extractor.js";

/**
 * Decision 736A, the resolution rules in isolation: which imports pick a definition and which are refused.
 * `test/import-disambiguation.test.ts` proves the same thing through the built CLI; this file pins the edge cases
 * that would be too slow or too noisy to set up there (every `it` below indexes a few in-memory files).
 *
 * Each case has two definitions of one name (`ping` or `Tool.make`), so that a call to it is ambiguous by name
 * alone; the result is read back as the CALLS edges the extractor wrote and as the ambiguous count.
 */

interface Out {
  /** `caller -> target` for every CALLS edge, ids as stored */
  edges: string[];
  confidence: Record<string, number>;
  ambiguous: number;
}

function index(files: Record<string, string>): Out {
  const r = extractProjectDetailed(Object.entries(files).map(([path, source]) => ({ path, source })));
  const edges: string[] = [];
  const confidence: Record<string, number> = {};
  for (const e of r.fragment.edges) {
    if (e.label !== "CALLS") continue;
    const key = `${e.from} -> ${e.to}`;
    edges.push(key);
    confidence[key] = Number(e.properties?.confidence);
  }
  return { edges: edges.sort(), confidence, ambiguous: r.ambiguous };
}

const PING_A = "def ping():\n    return 1\n";
const PING_B = "def ping():\n    return 2\n";

describe("import disambiguation: what an import is allowed to pick (Python)", () => {
  it("a from-import picks its module's definition and the edge says it came from an import [python-from-import]", () => {
    const o = index({
      "pkg/__init__.py": "",
      "pkg/a.py": PING_A,
      "pkg/b.py": PING_B,
      "app.py": "from pkg.a import ping\n\n\ndef run():\n    return ping()\n",
    });
    expect(o.edges).toEqual(["app.py#run -> pkg/a.py#ping"]);
    expect(o.confidence["app.py#run -> pkg/a.py#ping"]).toBe(0.7);
    expect(o.ambiguous).toBe(0);
  });

  it("the same call without an import stays ambiguous, and so does self.ping() next to an import of ping [python-self-receiver]", () => {
    const none = index({ "a.py": PING_A, "b.py": PING_B, "app.py": "def run():\n    return ping()\n" });
    expect(none.edges).toEqual([]);
    expect(none.ambiguous).toBe(1);

    const withSelf = index({
      "pkg/__init__.py": "",
      "pkg/a.py": PING_A,
      "pkg/b.py": PING_B,
      "app.py": "from pkg.a import ping\n\n\nclass K:\n    def run(self):\n        return self.ping()\n",
    });
    expect(withSelf.edges).toEqual([]);
    expect(withSelf.ambiguous).toBe(1);
  });

  it("two imports of one name from different modules are a conflict, not a pick [python-conflicting-imports]", () => {
    const o = index({
      "pkg/__init__.py": "",
      "pkg/a.py": PING_A,
      "pkg/b.py": PING_B,
      "app.py": "def one():\n    from pkg.a import ping\n    return ping()\n\n\ndef two():\n    from pkg.b import ping\n    return ping()\n",
    });
    expect(o.edges).toEqual([]);
    expect(o.ambiguous).toBe(2);
  });

  it("an aliased import is not mistaken for the name it renames [python-alias]", () => {
    const o = index({
      "pkg/__init__.py": "",
      "pkg/a.py": PING_A,
      "pkg/b.py": PING_B,
      "app.py": "from pkg.a import ping as p\n\n\ndef run():\n    return p()\n",
    });
    expect(o.edges).toEqual([]);
  });

  it("module receivers: import a.b, import a.b as x, from pkg import mod, and a relative import [python-module-receivers]", () => {
    const base = { "pkg/__init__.py": "", "pkg/a.py": PING_A, "pkg/b.py": PING_B, "pkg/sub/__init__.py": "", "pkg/sub/c.py": PING_A.replace("1", "3") };
    expect(index({ ...base, "app.py": "import pkg.a\n\n\ndef run():\n    return pkg.a.ping()\n" }).edges).toEqual(["app.py#run -> pkg/a.py#ping"]);
    expect(index({ ...base, "app.py": "import pkg.b as pb\n\n\ndef run():\n    return pb.ping()\n" }).edges).toEqual(["app.py#run -> pkg/b.py#ping"]);
    expect(index({ ...base, "app.py": "from pkg import a\n\n\ndef run():\n    return a.ping()\n" }).edges).toEqual(["app.py#run -> pkg/a.py#ping"]);
    // `..a` from pkg/sub/user.py is pkg/a.py; `.c` is pkg/sub/c.py
    expect(index({ ...base, "pkg/sub/user.py": "from .. import a\nfrom . import c\n\n\ndef go():\n    return a.ping()\n\n\ndef go2():\n    return c.ping()\n" }).edges).toEqual([
      "pkg/sub/user.py#go -> pkg/a.py#ping",
      "pkg/sub/user.py#go2 -> pkg/sub/c.py#ping",
    ]);
  });

  it("a package __init__ that re-exports, and a star re-export, lead to the defining file; a cycle of re-exports ends [python-reexport]", () => {
    const base = { "lib/a.py": PING_A, "lib/b.py": PING_B };
    expect(index({ ...base, "lib/__init__.py": "from .a import ping\n", "app.py": "from lib import ping\n\n\ndef run():\n    return ping()\n" }).edges).toEqual(["app.py#run -> lib/a.py#ping"]);
    expect(index({ ...base, "lib/__init__.py": "from .a import *\n", "app.py": "from lib import ping\n\n\ndef run():\n    return ping()\n" }).edges).toEqual(["app.py#run -> lib/a.py#ping"]);
    // a.py and b.py import each other's `ping`: neither defines it, and the walk must not loop
    const cyc = index({
      "lib/__init__.py": "",
      "lib/a.py": "from .b import ping\n",
      "lib/b.py": "from .a import ping\n",
      "other/ping_def.py": PING_A,
      "other/ping_def2.py": PING_B,
      "app.py": "from lib.a import ping\n\n\ndef run():\n    return ping()\n",
    });
    expect(cyc.edges).toEqual([]);
    expect(cyc.ambiguous).toBe(1);
  });

  it("the package root, not the index root, names a module: a src/ layout resolves, and a project file does not hide the standard library [python-module-names]", () => {
    const src = index({
      "src/mypkg/__init__.py": "",
      "src/mypkg/a.py": PING_A,
      "src/mypkg/b.py": PING_B,
      "src/app.py": "from mypkg.a import ping\n\n\ndef run():\n    return ping()\n",
    });
    expect(src.edges).toEqual(["src/app.py#run -> src/mypkg/a.py#ping"]);

    // pkg/json.py is `pkg.json`, never `json`: `import json` is the standard library and stays unresolved
    const std = index({
      "pkg/__init__.py": "",
      "pkg/json.py": PING_A,
      "pkg/other.py": PING_B,
      "app.py": "import json\n\n\ndef run():\n    return json.ping()\n",
    });
    expect(std.edges).toEqual([]);
    expect(std.ambiguous).toBe(1);

    // a script directory with no __init__ is imported by its file name
    const scripts = index({
      "tools/helpers.py": PING_A,
      "tools/other.py": PING_B,
      "tools/run.py": "from helpers import ping\n\n\ndef go():\n    return ping()\n",
    });
    expect(scripts.edges).toEqual(["tools/run.py#go -> tools/helpers.py#ping"]);
  });

  it("a class imported from a module picks that class's method for Tool.make(); a function of the same name elsewhere does not matter [python-class-static]", () => {
    const o = index({
      "m.py": "class Tool:\n    @staticmethod\n    def make():\n        return 1\n",
      "n.py": "class Other:\n    @staticmethod\n    def make():\n        return 2\n",
      "app.py": "from m import Tool\n\n\ndef run():\n    return Tool.make()\n",
    });
    expect(o.edges).toEqual(["app.py#run -> m.py#Tool.make"]);
  });

  it("a definition in the caller's own file keeps winning over an import of the same name [python-same-file-first]", () => {
    const o = index({
      "pkg/__init__.py": "",
      "pkg/a.py": PING_A,
      "pkg/b.py": PING_B,
      "app.py": "from pkg.a import ping\n\n\ndef ping():\n    return 0\n\n\ndef run():\n    return ping()\n",
    });
    expect(o.edges).toEqual(["app.py#run -> app.py#ping"]);
    expect(o.confidence["app.py#run -> app.py#ping"]).toBe(0.8);
  });
});

describe("import disambiguation: what an import is allowed to pick (TypeScript)", () => {
  const A = "export function ping() { return 1; }\n";
  const B = "export function ping() { return 2; }\n";

  it("named, aliased-away, default and package imports [ts-named]", () => {
    const base = { "a.ts": A, "b.ts": B };
    expect(index({ ...base, "app.ts": 'import { ping } from "./a";\nexport function run() { return ping(); }\n' }).edges).toEqual(["app.ts#run -> a.ts#ping"]);
    // a package or a path alias is not in the project's file set by name
    const pkg = index({ ...base, "app.ts": 'import { ping } from "some-lib";\nexport function run() { return ping(); }\n' });
    expect(pkg.edges).toEqual([]);
    expect(pkg.ambiguous).toBe(1);
    // `import ping from` is a default import: it is not the named export `ping`
    expect(index({ ...base, "app.ts": 'import ping from "./a";\nexport function run() { return ping(); }\n' }).edges).toEqual([]);
    // a renamed import names a different function than any `ping`
    expect(index({ ...base, "app.ts": 'import { ping as p } from "./a";\nexport function run() { return p(); }\n' }).edges).toEqual([]);
  });

  it("./x.js is ./x.ts, a directory is its index.ts, and a barrel re-exports by name, by star and as a namespace [ts-resolution]", () => {
    const files = { "lib/a.ts": A, "lib/b.ts": B, "lib/index.ts": 'export { ping } from "./a";\n' };
    expect(index({ ...files, "app.ts": 'import { ping } from "./lib/a.js";\nexport function run() { return ping(); }\n' }).edges).toEqual(["app.ts#run -> lib/a.ts#ping"]);
    expect(index({ ...files, "app.ts": 'import { ping } from "./lib";\nexport function run() { return ping(); }\n' }).edges).toEqual(["app.ts#run -> lib/a.ts#ping"]);
    expect(index({ ...files, "lib/index.ts": 'export * from "./a";\n', "app.ts": 'import { ping } from "./lib";\nexport function run() { return ping(); }\n' }).edges).toEqual([
      "app.ts#run -> lib/a.ts#ping",
    ]);
    expect(index({ ...files, "lib/index.ts": 'export * as ns from "./a";\n', "app.ts": 'import { ns } from "./lib";\nexport function run() { return ns.ping(); }\n' }).edges).toEqual([
      "app.ts#run -> lib/a.ts#ping",
    ]);
    expect(index({ ...files, "app.ts": 'import * as lib from "./lib/b";\nexport function run() { return lib.ping(); }\n' }).edges).toEqual(["app.ts#run -> lib/b.ts#ping"]);
  });

  it("an object's own method is not an imported module's function [ts-receiver]", () => {
    const o = index({ "a.ts": A, "b.ts": B, "app.ts": 'import { ping } from "./a";\nexport function run(o: { ping(): number }) { return o.ping(); }\n' });
    expect(o.edges).toEqual([]);
    expect(o.ambiguous).toBe(1);
  });
});

describe("what the extractor records about a call's receiver", () => {
  it("none for a bare call, the dotted text for a chain, '?' for anything else, and the file's bindings [receiver-facts]", () => {
    const r = extractProjectDetailed([
      {
        path: "x.py",
        source: "import a.b as ab\nfrom . import m\n\n\ndef f(o):\n    g()\n    ab.h()\n    a.b.c.k()\n    o().z()\n    self.w()\n",
      },
    ]);
    const facts = r.facts[0]!;
    const byCallee = Object.fromEntries(facts.calls.map((c) => [c[1], c[3]]));
    expect(byCallee).toEqual({ g: undefined, h: "ab", k: "a.b.c", z: "?", w: "self" });
    expect(facts.bindings).toEqual([
      ["ab", "a.b", ""],
      ["m", ".", "m"],
    ]);
  });
});
