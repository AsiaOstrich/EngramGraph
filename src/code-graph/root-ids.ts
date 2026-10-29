/**
 * Which graph id each file of an index root gets (XSPEC-508 R6, decision 134乙).
 *
 * ## The problem
 *
 * A Module id is the file's path relative to its index root, and a Function/Class id starts with
 * it. One graph is often built from several roots (dev-platform's `index-all.sh` indexes seven
 * into one DB), so two roots that both hold `src/index.ts` wrote ONE Module node, with the
 * functions of both files under it and the call edges of both attached to the same function ids.
 * Nothing refused it and nothing showed it, and an incremental index, which must delete "this
 * root's copy" of a file, could not do that without deleting the other root's.
 *
 * ## The rule
 *
 * A file keeps its plain relative path as its id, as it always has, UNLESS another root of the
 * same graph already holds that id. Then it gets `<root label>/<relative path>`. Three
 * consequences follow, and they are the reason for this shape rather than prefixing every id:
 *
 *  - A graph that has one root, or several roots whose relative paths never meet, has the same
 *    ids as before. Nothing is rebuilt, `egr callers`/`implemented-by`/SAGE confidence keep
 *    working on what is already there. (Measured on dev-platform's seven roots: one path of 3,076
 *    meets another.)
 *  - An id never changes while its file stays in its section. The id a file was given is
 *    recorded in the parse-health manifest (`FileParseHealth.id`, only when it is not the path)
 *    and read back on the next run, so a root that LATER gains a colliding file, or a second
 *    root that arrives LATER, cannot rename what is already in the graph. The cost is that the
 *    ids depend on which root was indexed first (the first keeps the plain path). Rebuilding a
 *    graph in another order gives other ids; `index-all.sh` indexes in a fixed order.
 *  - The incremental state needs no root awareness: every id belongs to exactly one file of one
 *    root, so deleting a root's gone files cannot touch another root's nodes.
 *
 * ## What it cannot repair
 *
 * A graph written by an egr that did not have this rule can already hold ONE node for a path of
 * two roots (both sections list the same id). Those nodes are mixed and no run can tell which
 * function or edge belongs to which root. {@link assignIds} reports them in `shared`; the caller
 * says so and tells the user to rebuild (`--clean`, or `index-all.sh --clean`), and an incremental
 * run indexes in full instead of diffing against them.
 */

import { MCP_INDEX_ROOT, type ParseManifest } from "./parse-manifest.js";
import { canonicalFilePath, toPosixPath } from "./path-utils.js";

/**
 * The label a root is known by in qualified ids: its last two path segments
 * (`/work/dev-platform/EngramGraph/src` -> `EngramGraph/src`). The last segment alone is no
 * use: three of dev-platform's roots are named `src`. `#` is dropped because it separates a
 * Module id from its Function.
 */
export function defaultRootLabel(root: string): string {
  const parts = toPosixPath(root).split("/").filter((p) => p !== "");
  const label = parts.slice(-2).join("/").replace(/#/g, "_");
  return label === "" ? "root" : label;
}

/** The label `section` of `root` already uses, or would use. */
function labelOf(root: string, manifest: ParseManifest): string {
  return manifest.runs[root]?.rootLabel ?? defaultRootLabel(root);
}

/** What {@link assignIds} decided for one root. */
export interface IdAssignment {
  /** Relative path -> graph id, for every path given. */
  ids: Map<string, string>;
  /** Files whose id is not their path. */
  qualified: number;
  /** The label to keep in this root's manifest section; absent while no file needed one. */
  rootLabel?: string;
  /** Ids this root's section holds that another root's section holds too: nodes mixed by an older egr. */
  shared: Array<{ id: string; otherRoot: string }>;
}

/**
 * Decide the graph id of each of `relPaths` (POSIX paths relative to `root`).
 *
 * `manifest` is the manifest as the graph stands NOW (`null` for a graph with none, and for
 * `--clean`, which empties the graph: there is then nothing for an id to collide with).
 */
export function assignIds(args: { root: string; manifest: ParseManifest | null; relPaths: readonly string[] }): IdAssignment {
  const { root, manifest, relPaths } = args;
  const own = manifest?.runs[root];

  // The same directory spelled two ways (through a symlink, as `index-all.sh` does, and by its real
  // path) is ONE root, not two: its files are the same files and must keep one set of ids.
  const here = canonicalFilePath(root);
  const sameDirectory = (other: string): boolean => other === root || canonicalFilePath(other) === here;
  // The MCP `index_code` record is not a root (see MCP_INDEX_ROOT): a file indexed through it IS the
  // file `egr index` wrote, so it neither takes an id from a root nor makes one "shared".
  const isRoot = (key: string): boolean => key !== MCP_INDEX_ROOT;

  // Ids the OTHER roots' sections hold (a section written by an older egr holds its plain paths).
  const occupied = new Map<string, string>();
  for (const [other, section] of Object.entries(manifest?.runs ?? {})) {
    if (sameDirectory(other) || !isRoot(other)) continue;
    for (const f of section.files ?? []) occupied.set(f.id ?? f.path, other);
  }

  // What this directory's files were called before: its own section first, then another spelling's.
  const recorded = new Map<string, string>();
  for (const [other, section] of Object.entries(manifest?.runs ?? {})) {
    if (other === root || !sameDirectory(other)) continue;
    for (const f of section.files ?? []) recorded.set(f.path, f.id ?? f.path);
  }
  for (const f of own?.files ?? []) recorded.set(f.path, f.id ?? f.path);

  const wanted = new Set(relPaths);
  const ids = new Map<string, string>();
  const shared: IdAssignment["shared"] = [];
  const taken = new Set<string>();

  // 1. Files this section already has keep their id, whatever the other roots hold now.
  for (const rel of relPaths) {
    const id = recorded.get(rel);
    if (id === undefined) continue;
    ids.set(rel, id);
    taken.add(id);
    const holder = occupied.get(id);
    if (holder !== undefined) shared.push({ id, otherRoot: holder });
  }

  // 2. A new file takes its plain path if nobody holds it ...
  const pending: string[] = [];
  for (const rel of relPaths) {
    if (ids.has(rel)) continue;
    if (!occupied.has(rel) && !taken.has(rel)) {
      ids.set(rel, rel);
      taken.add(rel);
    } else {
      pending.push(rel);
    }
  }

  // 3. ... else the root-qualified one. The label is the one already stored, else the default made
  //    different from every other root's label.
  let label: string | undefined = own?.rootLabel ?? Object.entries(manifest?.runs ?? {}).find(([o, sec]) => o !== root && sameDirectory(o) && sec.rootLabel)?.[1].rootLabel;
  if (pending.length > 0 && label === undefined) {
    const others = new Set(Object.keys(manifest?.runs ?? {}).filter((r) => !sameDirectory(r) && isRoot(r)).map((r) => labelOf(r, manifest!)));
    label = defaultRootLabel(root);
    for (let n = 2; others.has(label); n += 1) label = `${defaultRootLabel(root)}~${n}`;
  }
  for (const rel of pending) {
    let id = `${label}/${rel}`;
    // A path that already looks like `<label>/…` can meet a qualified id; a counter on the label
    // keeps the ids distinct without renaming anything that exists.
    for (let n = 2; occupied.has(id) || taken.has(id) || wanted.has(id); n += 1) id = `${label}~${n}/${rel}`;
    ids.set(rel, id);
    taken.add(id);
  }

  const qualified = [...ids].filter(([rel, id]) => rel !== id).length;
  return {
    ids,
    qualified,
    ...(label !== undefined ? { rootLabel: label } : {}),
    shared,
  };
}
