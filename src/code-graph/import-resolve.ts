/**
 * Pick one definition among several of the same name by what the CALLER's file imports (decision 736A).
 *
 * {@link resolveFacts} binds a call by its bare name: same file first, then the one definition in the whole batch,
 * else the call is dropped as ambiguous. Two functions named `render` in different files are therefore never
 * linked from any caller outside their own file, even when the caller says exactly which one it means
 * (`from a.util import render`). This module is what says it.
 *
 * It only ever CHOOSES AMONG the candidate ids it is handed (the definitions of that name). It does not invent a
 * link and it does not look at a call that already resolved. When the imports do not name exactly one candidate
 * — the module is not in the project, the name is imported twice from different places, the receiver is not an
 * imported module, the target is not a top-level definition — it returns `undefined` and the call stays
 * ambiguous. Not guessing is the point: a wrong edge is worse than a missing one.
 *
 * What counts as evidence, for a call `callee` made on `receiver` (see `tag-query-engine.ts`'s `receiverOf`):
 *
 *  - no receiver (`render()`): the file imported the name — `from a.util import render` /
 *    `import { render } from "./a"`. The module is found, the name followed through the module's own re-exports
 *    (`__init__.py`, a barrel `index.ts`) to the file that defines it;
 *  - a receiver that is an imported module (`import b.util as bu` + `bu.render()`, `from pkg import util` +
 *    `util.render()`, `import * as ns` + `ns.render()`): the module's definition of `callee`, followed the same way;
 *  - a receiver that is an imported class (`from m import Foo` + `Foo.make()`): `Foo`'s method of that name.
 *
 * Anything else — `self.render()`, `obj.render()`, `f().render()` — has no evidence here and stays ambiguous.
 *
 * Module -> file resolution is by path inside the batch only:
 *
 *  - Python relative imports (`.x`, `..p.q`) count from the importing file's directory; an absolute `a.b.c` is
 *    looked up by the dotted name each Python file answers to, computed from its own package root (the first
 *    directory from which every directory down to the file has an `__init__.py`) and from the index root. The
 *    package root, not the index root, because `egr index` is often pointed at a repository whose package sits
 *    under `src/`;
 *  - TypeScript / JavaScript: only relative specifiers (`./x`, `../y.js`), tried as the file itself, with each
 *    TypeScript / JavaScript extension, and as `<dir>/index.<ext>`. A package name or a `tsconfig` path alias is not
 *    resolved: it stays ambiguous (documented limit).
 *
 * Everything here is a pure function of the facts, so an incremental run that resolves the previous and the new
 * facts gets the same answer a full run would.
 */

import { posix } from "node:path";

import type { FileFacts } from "./extractor.js";
import { importFamilyOf, type ImportBinding, type ImportFamily } from "./import-bindings.js";

/** The per-batch lookup tables the resolution reads; build once per {@link resolveFacts} call. */
export interface ImportIndex {
  byPath: Map<string, FileFacts>;
  /** Python dotted module name -> the Python files that answer to it. */
  pythonModules: Map<string, FileFacts[]>;
  fnIds: Map<FileFacts, Set<string>>;
  classIds: Map<FileFacts, Set<string>>;
}

const ECMA_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function buildImportIndex(facts: readonly FileFacts[]): ImportIndex {
  const byPath = new Map<string, FileFacts>();
  const fnIds = new Map<FileFacts, Set<string>>();
  const classIds = new Map<FileFacts, Set<string>>();
  for (const f of facts) {
    byPath.set(f.path, f);
    fnIds.set(f, new Set(f.fnIds));
    classIds.set(f, new Set(f.classIds));
  }

  // Python: which directories are packages, then the dotted names each file answers to.
  const pythonFiles = facts.filter((f) => f.language === "python");
  const packageDirs = new Set<string>();
  for (const f of pythonFiles) if (posix.basename(f.path) === "__init__.py") packageDirs.add(posix.dirname(f.path));
  const pythonModules = new Map<string, FileFacts[]>();
  const add = (key: string, f: FileFacts): void => {
    const list = pythonModules.get(key);
    if (!list) pythonModules.set(key, [f]);
    else if (!list.includes(f)) list.push(f);
  };
  for (const f of pythonFiles) {
    const stem = f.path.replace(/\.py$/, "");
    const isInit = posix.basename(stem) === "__init__";
    // the module's own dotted path: `src/beta/inner/sub.py` -> src, beta, inner, sub; `src/alpha/__init__.py` -> src, alpha
    const parts = (isInit ? posix.dirname(stem) : stem).split("/").filter((p) => p !== "" && p !== ".");
    if (parts.length === 0) continue;
    // From the index root: the dotted path of the file as it sits.
    add(parts.join("."), f);
    // From the package root: step up while the directory is itself a package. The directories that must be packages
    // are all of `parts` for an `__init__.py` (its own directory is the package) and all but the last otherwise.
    const chain = isInit ? parts : parts.slice(0, -1);
    let start = chain.length;
    while (start > 0 && packageDirs.has(chain.slice(0, start).join("/"))) start -= 1;
    if (start > 0) add(parts.slice(start).join("."), f);
  }
  return { byPath, pythonModules, fnIds, classIds };
}

// -- spec -> file ---------------------------------------------------------------------------------------------------

function resolvePythonModule(ix: ImportIndex, from: FileFacts, spec: string): FileFacts | undefined {
  const dots = /^\.*/.exec(spec)![0].length;
  const rest = spec.slice(dots);
  if (dots > 0) {
    let base = posix.dirname(from.path);
    for (let i = 1; i < dots; i++) base = posix.dirname(base);
    const stem = rest === "" ? base : posix.join(base, rest.replace(/\./g, "/"));
    const norm = posix.normalize(stem);
    const init = ix.byPath.get(`${norm === "." ? "" : `${norm}/`}__init__.py`);
    // `from . import x` names the package itself, never a sibling module that happens to share its directory's name
    return rest === "" ? init : (ix.byPath.get(`${norm}.py`) ?? init);
  }
  const hits = (ix.pythonModules.get(rest) ?? []).filter((h) => h !== from);
  if (hits.length <= 1) return hits[0];
  // Several files answer to this name: the nearest one to the importer wins, a tie wins nothing.
  const near = (h: FileFacts): number => {
    const a = from.path.split("/");
    const b = h.path.split("/");
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };
  const best = Math.max(...hits.map(near));
  const top = hits.filter((h) => near(h) === best);
  return top.length === 1 ? top[0] : undefined;
}

function resolveEcmaModule(ix: ImportIndex, from: FileFacts, spec: string): FileFacts | undefined {
  if (!spec.startsWith(".")) return undefined; // a package or a path alias: not in this project's file set by name
  const base = posix.normalize(posix.join(posix.dirname(from.path), spec));
  const candidates: string[] = [];
  // `./x.js` is how TypeScript names `./x.ts`
  const swap: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
  const ext = posix.extname(base);
  if (ECMA_EXTENSIONS.includes(ext)) {
    candidates.push(base);
    for (const alt of swap[ext] ?? []) candidates.push(base.slice(0, -ext.length) + alt);
  }
  for (const e of ECMA_EXTENSIONS) candidates.push(base + e);
  for (const e of ECMA_EXTENSIONS) candidates.push(posix.join(base, `index${e}`));
  for (const c of candidates) {
    const hit = ix.byPath.get(c);
    if (hit) return hit;
  }
  return undefined;
}

function resolveModule(ix: ImportIndex, from: FileFacts, spec: string): FileFacts | undefined {
  const family = importFamilyOf(from.language);
  if (family === "python") return resolvePythonModule(ix, from, spec);
  if (family === "ecmascript") return resolveEcmaModule(ix, from, spec);
  return undefined;
}

/** `pkg` + `sub` -> `pkg.sub`; `.` + `x` -> `.x`; `.p` + `x` -> `.p.x` */
function joinSpec(spec: string, name: string): string {
  return /\.$/.test(spec) ? spec + name : `${spec}.${name}`;
}

// -- what a module exports ------------------------------------------------------------------------------------------

/** Where an exported name ends up. */
type Exported = { kind: "def"; file: FileFacts; name: string } | { kind: "module"; file: FileFacts };

const MAX_REEXPORT_DEPTH = 6;

/** The binding of `local` in `f`, `null` when there is none, `"conflict"` when the file binds it to two different things. */
function bindingOf(f: FileFacts, local: string): ImportBinding | null | "conflict" {
  let found: ImportBinding | null = null;
  for (const b of f.bindings ?? []) {
    if (b[0] !== local) continue;
    if (found && (found[1] !== b[1] || found[2] !== b[2])) return "conflict";
    found = b;
  }
  return found;
}

/**
 * What `name` is, as seen from module file `m`: a function or class it defines at the top level, a module it
 * re-exports or contains, or whatever one of its re-exports leads to. `undefined` when it cannot be told apart.
 */
function lookupExport(ix: ImportIndex, m: FileFacts, name: string, depth = 0, seen: Set<FileFacts> = new Set()): Exported | undefined {
  if (depth > MAX_REEXPORT_DEPTH || seen.has(m)) return undefined;
  seen.add(m);
  const id = moduleIdOfFacts(m);
  if (ix.fnIds.get(m)!.has(`${id}#${name}`) || ix.classIds.get(m)!.has(`${id}#class:${name}`)) return { kind: "def", file: m, name };

  const b = bindingOf(m, name);
  if (b === "conflict") return undefined;
  if (b && b[0] !== "*") {
    const target = resolveModule(ix, m, b[1]);
    if (b[2] === "") return target ? { kind: "module", file: target } : undefined; // `import x as name`
    if (target) {
      const via = lookupExport(ix, target, b[2], depth + 1, new Set(seen));
      if (via) return via;
    }
    // `from pkg import sub`: `sub` can be a module rather than a name inside pkg
    const sub = resolveModule(ix, m, joinSpec(b[1], b[2]));
    return sub ? { kind: "module", file: sub } : undefined;
  }

  // a Python package names its own submodules: `pkg/__init__.py` + `pkg/name.py`
  if (importFamilyOf(m.language) === "python" && posix.basename(m.path) === "__init__.py") {
    const sub = ix.byPath.get(posix.join(posix.dirname(m.path), `${name}.py`)) ?? ix.byPath.get(posix.join(posix.dirname(m.path), name, "__init__.py"));
    if (sub) return { kind: "module", file: sub };
  }

  // `from x import *` / `export * from "./x"`: exactly one star source may lead somewhere, else nothing is claimed
  const stars = (m.bindings ?? []).filter((s) => s[0] === "*");
  const hits: Exported[] = [];
  for (const s of stars) {
    const target = resolveModule(ix, m, s[1]);
    if (!target) continue;
    const via = lookupExport(ix, target, name, depth + 1, new Set(seen));
    if (via) hits.push(via);
  }
  const first = hits[0];
  if (first && hits.every((h) => h.file === first.file && h.kind === first.kind && (h.kind === "module" || (first.kind === "def" && h.name === first.name)))) return first;
  return undefined;
}

function moduleIdOfFacts(f: FileFacts): string {
  return f.moduleId ?? f.path;
}

// -- the call -------------------------------------------------------------------------------------------------------

/**
 * The one candidate definition the caller's imports name for this call, or `undefined`.
 *
 * @param from       the file the call is in
 * @param receiver   `undefined` for a bare call, else the dotted text of what it is called on (`"?"` when unplain)
 * @param callee     the bare name called
 * @param candidates ids of every definition that carries `callee`; the result is always one of them
 */
export function resolveByImport(
  ix: ImportIndex,
  from: FileFacts,
  receiver: string | undefined,
  callee: string,
  candidates: ReadonlySet<string>,
): string | undefined {
  const family: ImportFamily | undefined = importFamilyOf(from.language);
  if (family === undefined || !from.bindings?.length) return undefined;
  const pick = (id: string): string | undefined => (candidates.has(id) ? id : undefined);

  if (receiver === undefined) {
    const b = bindingOf(from, callee);
    if (!b || b === "conflict" || b[0] === "*" || b[2] === "" || b[2] === "default") return undefined;
    if (b[2] !== callee) return undefined; // `import foo as bar; bar()` names a different function than any `bar`
    const target = resolveModule(ix, from, b[1]);
    if (!target) return undefined;
    const hit = lookupExport(ix, target, b[2]);
    return hit?.kind === "def" ? pick(`${moduleIdOfFacts(hit.file)}#${hit.name}`) : undefined;
  }

  if (receiver === "?") return undefined;
  const segments = receiver.split(".");
  const head = bindingOf(from, segments[0]!);
  if (!head || head === "conflict" || head[0] === "*") return undefined;
  const rest = segments.slice(1);

  // Which module (or class) does the receiver name?
  let module: FileFacts | undefined;
  let cls: { file: FileFacts; name: string } | undefined;
  if (head[2] === "") {
    // the whole module is bound: `import a.b as x`, `import a.b` (local `a`), `import * as ns`
    if (family === "python") module = resolveModule(ix, from, rest.length > 0 ? `${head[1]}.${rest.join(".")}` : head[1]);
    else if (rest.length === 0) module = resolveModule(ix, from, head[1]);
  } else if (head[2] !== "default" && rest.length === 0) {
    // `from m import X`: X is a module, or a class of the module
    const target = resolveModule(ix, from, head[1]);
    const hit = target ? lookupExport(ix, target, head[2]) : undefined;
    if (hit?.kind === "module") module = hit.file;
    else if (hit?.kind === "def") cls = { file: hit.file, name: hit.name };
    else module = resolveModule(ix, from, joinSpec(head[1], head[2]));
  } else if (head[2] !== "default" && family === "python") {
    // `from pkg import sub` + `sub.inner.f()`
    module = resolveModule(ix, from, `${joinSpec(head[1], head[2])}.${rest.join(".")}`);
  }

  if (module) {
    const hit = lookupExport(ix, module, callee);
    return hit?.kind === "def" ? pick(`${moduleIdOfFacts(hit.file)}#${hit.name}`) : undefined;
  }
  if (cls) return pick(`${moduleIdOfFacts(cls.file)}#${cls.name}.${callee}`);
  return undefined;
}
