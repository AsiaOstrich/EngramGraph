// SPDX-License-Identifier: MIT
// implements XSPEC-514
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";
import { runEgr } from "./helpers/run-egr.js";

/**
 * Decision 736A — a call to a name that several functions share is tied to the definition its own file imports.
 *
 * Before: a call whose name matched more than one function (and no function of that name sits in the caller's file)
 * was dropped as "ambiguous", so `egr callers <name> --file <one definition>` could not list it at all. Now the
 * caller's imports pick the definition when they name exactly one; when they do not (an external package, an
 * unknown receiver) the call stays ambiguous and is not guessed.
 *
 * Everything below goes through the built `egr` CLI as a child process against a project this file writes and
 * indexes with `egr index`; the answer is read back from `egr callers`. The child processes get none of the
 * variables git exports to a hook (`git rev-parse --local-env-vars`).
 *
 * Python fixture, three definitions of `render_py` (a `src/` layout: `src` is not a package, `alpha`/`beta` are):
 *   src/alpha/util.py          render_py            (re-exported by src/alpha/__init__.py)
 *   src/beta/util.py           render_py
 *   src/beta/inner/sub.py      render_py
 * Callers:
 *   page_from      from alpha.util import render_py
 *   page_lazy      `from alpha import util` inside the function, then util.render_py()
 *   page_reexp     from alpha import render_py                 (alpha/__init__.py: from .util import render_py)
 *   page_mod       import beta.util as bu ; bu.render_py()
 *   page_rel       from .sub import render_py                  (a relative import)
 *   page_unknown   obj.render_py()                             (no import says what obj is)
 *   page_ext       from requests import render_py              (a package that is not in the project)
 *   page_same      `self.render_py()` is not exercised; same-file calls keep winning (page_local below)
 *   page_local     defines render_py itself and calls it       (the same-file definition, unchanged)
 *
 * TypeScript fixture, two definitions of `renderTs`:
 *   ts/a/render.ts (re-exported by the barrel ts/a/index.ts)   ts/b/render.ts
 *   pageA   import { renderTs } from "./a/render"
 *   pageBarrel  import { renderTs } from "./a"
 *   pageB   import * as b from "./b/render"; b.renderTs()
 *   pageX   import { renderTs } from "some-lib"                (external)
 */

let built: BuiltEgr;
let work: string;
let proj: string;
let db: string;
let env: NodeJS.ProcessEnv;
let indexOut: string;

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const n of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: process.env }).split("\n")) {
    if (n.trim()) delete e[n.trim()];
  }
  return {
    ...e,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: dirname(work),
    ENGRAM_DB: db,
  };
}

function put(rel: string, content: string): void {
  const full = join(proj, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const egr = (...args: string[]) => runEgr(built.cli, args, { env, cwd: work });

interface Row {
  id: string;
  name: string;
  file: string;
}
const callersOf = (name: string, file?: string): string[] => {
  const r = egr("callers", name, ...(file ? ["--file", file] : []), "--json");
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as Row[]).map((x) => x.name).sort();
};

beforeAll(() => {
  built = buildEgr();
  work = realpathSync(mkdtempSync(join(tmpdir(), "egr-imp-")));
  const home = join(work, "home");
  mkdirSync(home);
  proj = join(work, "proj");
  db = join(work, "g.db");
  env = isolatedEnv(home);

  // ---- Python ----
  put("src/alpha/__init__.py", "from .util import render_py\n");
  put("src/alpha/util.py", "def render_py(x):\n    return x\n");
  put("src/beta/__init__.py", "\n");
  put("src/beta/util.py", "def render_py(x):\n    return x * 2\n");
  put("src/beta/inner/__init__.py", "\n");
  put("src/beta/inner/sub.py", "def render_py(x):\n    return x * 3\n");
  put("src/beta/inner/use_rel.py", "from .sub import render_py\n\n\ndef page_rel():\n    return render_py(3)\n");
  put("src/app_from.py", "from alpha.util import render_py\n\n\ndef page_from():\n    return render_py(1)\n");
  put("src/app_lazy.py", "def page_lazy():\n    from alpha import util\n    return util.render_py(5)\n");
  put("src/app_reexp.py", "from alpha import render_py\n\n\ndef page_reexp():\n    return render_py(6)\n");
  put("src/app_mod.py", "import beta.util as bu\n\n\ndef page_mod():\n    return bu.render_py(2)\n");
  put("src/app_unknown.py", "def page_unknown(obj):\n    return obj.render_py(4)\n");
  put("src/app_ext.py", "from requests import render_py\n\n\ndef page_ext():\n    return render_py(7)\n");
  put("src/app_local.py", "def render_py(x):\n    return x\n\n\ndef page_local():\n    return render_py(8)\n");

  // ---- TypeScript ----
  put("ts/a/render.ts", "export function renderTs() { return 1; }\n");
  put("ts/a/index.ts", 'export { renderTs } from "./render";\n');
  put("ts/b/render.ts", "export function renderTs() { return 2; }\n");
  put("ts/pageA.ts", 'import { renderTs } from "./a/render";\nexport function pageA() { return renderTs(); }\n');
  put("ts/pageBarrel.ts", 'import { renderTs } from "./a";\nexport function pageBarrel() { return renderTs(); }\n');
  put("ts/pageB.ts", 'import * as b from "./b/render";\nexport function pageB() { return b.renderTs(); }\n');
  put("ts/pageX.ts", 'import { renderTs } from "some-lib";\nexport function pageX() { return renderTs(); }\n');

  const r = egr("index", proj);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
  indexOut = r.stdout;
}, 180_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("decision 736A: a same-name call is tied to the definition its file imports (egr callers, from the built CLI)", () => {
  it("--file narrows a Python name to the callers whose import names that definition [import-disambiguation-py-file]", () => {
    // `from alpha.util import ...`, `from alpha import util` + util.x(), and a re-export through alpha/__init__.py
    expect(callersOf("render_py", "src/alpha/util.py")).toEqual(["page_from", "page_lazy", "page_reexp"]);
    // `import beta.util as bu` + bu.x()
    expect(callersOf("render_py", "src/beta/util.py")).toEqual(["page_mod"]);
    // a relative import
    expect(callersOf("render_py", "src/beta/inner/sub.py")).toEqual(["page_rel"]);
    // the file's own definition keeps its same-file caller and nothing else
    expect(callersOf("render_py", "src/app_local.py")).toEqual(["page_local"]);
  });

  it("without --file the answer is still merged, and holds the import-resolved callers of every definition [import-disambiguation-py-merged]", () => {
    const text = egr("callers", "render_py");
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("merged");
    expect(text.stdout).toContain("defined 4 times");
    expect(callersOf("render_py")).toEqual(["page_from", "page_lazy", "page_local", "page_mod", "page_reexp", "page_rel"]);
  });

  it("a call whose imports do not name one definition is not guessed: an unknown receiver and an external package stay unlinked [import-disambiguation-unclear]", () => {
    const everyone = callersOf("render_py");
    expect(everyone).not.toContain("page_unknown");
    expect(everyone).not.toContain("page_ext");
    for (const file of ["src/alpha/util.py", "src/beta/util.py", "src/beta/inner/sub.py", "src/app_local.py"]) {
      const some = callersOf("render_py", file);
      expect(some).not.toContain("page_unknown");
      expect(some).not.toContain("page_ext");
    }
    // they are counted as ambiguous in the index summary: page_unknown, page_ext (python), pageX (ts)
    expect(indexOut).toMatch(/\(ambiguous 3, unresolved \d+\)/);
  });

  it("TypeScript: named import, barrel re-export and namespace import each pick their definition; an external package does not [import-disambiguation-ts]", () => {
    expect(callersOf("renderTs", "ts/a/render.ts")).toEqual(["pageA", "pageBarrel"]);
    expect(callersOf("renderTs", "ts/b/render.ts")).toEqual(["pageB"]);
    expect(callersOf("renderTs")).toEqual(["pageA", "pageB", "pageBarrel"]);
    expect(callersOf("renderTs")).not.toContain("pageX");
  });
});

describe("decision 736A: an incremental index ends with the graph a full index gives", () => {
  it("changing only the CALLER's import moves its edge, and a from-scratch index of the same files reads back the same [import-disambiguation-incremental]", () => {
    const proj2 = join(work, "proj2");
    const putTo = (rel: string, content: string): void => {
      const full = join(proj2, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    putTo("inc/a/__init__.py", "\n");
    putTo("inc/a/util.py", "def ping_i():\n    return 1\n");
    putTo("inc/b/__init__.py", "\n");
    putTo("inc/b/util.py", "def ping_i():\n    return 2\n");
    putTo("inc/user.py", "from a.util import ping_i\n\n\ndef go():\n    return ping_i()\n");

    const inc = (...args: string[]) => runEgr(built.cli, args, { env: { ...env, ENGRAM_DB: join(work, "inc.db") }, cwd: work });
    const callersIn = (e: (...a: string[]) => ReturnType<typeof runEgr>, file: string): string[] => {
      const r = e("callers", "ping_i", "--file", file, "--json");
      expect(r.status, r.stderr).toBe(0);
      return (JSON.parse(r.stdout) as Row[]).map((x) => x.name).sort();
    };

    expect(inc("index", proj2, "--incremental").status).toBe(0);
    expect(callersIn(inc, "inc/a/util.py")).toEqual(["go"]);
    expect(callersIn(inc, "inc/b/util.py")).toEqual([]);

    // only the caller changes: it now imports the other definition
    putTo("inc/user.py", "from b.util import ping_i\n\n\ndef go():\n    return ping_i()\n");
    const second = inc("index", proj2, "--incremental");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("incremental:");
    expect(second.stdout).not.toContain("indexed in full");
    expect(callersIn(inc, "inc/a/util.py")).toEqual([]);
    expect(callersIn(inc, "inc/b/util.py")).toEqual(["go"]);

    // the same files indexed from scratch into another graph answer the same
    const fresh = (...args: string[]) => runEgr(built.cli, args, { env: { ...env, ENGRAM_DB: join(work, "fresh.db") }, cwd: work });
    expect(fresh("index", proj2).status).toBe(0);
    expect(callersIn(fresh, "inc/a/util.py")).toEqual([]);
    expect(callersIn(fresh, "inc/b/util.py")).toEqual(["go"]);
  });
});

