/**
 * `egr refs check` — verify code references cited in Markdown are still
 * accurate (DEC-115 L2, https://github.com/AsiaOstrich/dev-platform →
 * cross-project/decisions/DEC-115-memory-code-reference-check.md).
 *
 * ## What this checks, and why "unresolvable" is a real third answer
 *
 * AI memory/notes/README files cite code by file path or by symbol name.
 * Code moves; the citation doesn't update itself. A naive "does this path
 * exist" check is wrong more than it's right. So every reference gets one of
 * four answers, and `unresolvable` is not a synonym for "missing" — it means
 * this checker does not have enough information to say either way (e.g. the
 * reference names a repo this graph was never told to index, or gives a bare
 * filename with no directory). Reporting `missing` there would be a false
 * claim of certainty this tool does not have.
 *
 * ## H1 baseline (2026-09) and what it changed here
 *
 * The first real run — 270 memory files against dev-platform's multi-repo
 * graph, 2,375 references — fell well short of DEC-115's H1 accuracy bar.
 * Walking the false `missing`/`moved` results by hand found five distinct,
 * fixable causes, and this revision (round 2) addresses each one
 * structurally rather than patching individual strings:
 *
 *   1. **Bare filenames** (`App.tsx`, no directory) were the largest single
 *      bucket. A bare filename cannot be judged present/missing without
 *      guessing which of possibly several files it means — see
 *      {@link resolveBareFilename}.
 *   2. **Real, existing files that were never Module nodes** — most
 *      non-code files (`.md`, `.sh`, `.yaml`, docs) are never walked into a
 *      `Module` node at all (only `egr index`'s source-code walk creates
 *      those), so a graph-only check reported them missing even though they
 *      exist on disk. Every resolution path here now checks the FILESYSTEM
 *      under each indexed root, not just the graph.
 *   3. **Home-directory and absolute references** outside any indexed root
 *      are `unresolvable`, not `missing` — this was already the rule for
 *      absolute paths in round 1; round 2 also expands a leading `~` so it
 *      goes through the same check.
 *   4. **Extraction over-matched non-path shapes**: glob/regex/placeholder
 *      syntax, conventional-commit branch names (`feat/xspec-…`), GitHub
 *      `owner/repo`(`#N`) shorthand, npm package specs (`pkg@ver`,
 *      `@scope/pkg@ver`), `key=value` pairs, and bare slash-separated word
 *      lists with no extension all look enough like a path to fool a naive
 *      "contains a slash" rule. None of them is a checkable path — see
 *      {@link looksLikePath}.
 *   5. **Dotted "member call" symbols** (`process.cwd()`, `os.tmpdir()`,
 *      `useAuth.restore()`) used to fall back to matching just the LAST
 *      segment (`cwd`, `tmpdir`, `restore`) against ANY Function in the
 *      graph — which is exactly the "same name in an unrelated place" guess
 *      DEC-115 D2 forbids, and is how `useAuth.restore()` got reported
 *      `moved` to a same-named `restore` it has nothing to do with. That
 *      fallback is gone; see {@link resolveSymbolRef}.
 *
 * ## This module ONLY reads: the graph, the filesystem, and `git log`
 *
 * Per the EGR README ("What EngramGraph does not store") and XSPEC-373: this
 * is a checker, not a second memory store. It never writes to the graph
 * connection it is given (verified in `test/refs-check.test.ts` by comparing
 * node/edge counts before and after), and it never writes the Markdown files
 * it reads.
 *
 * ## Extraction rule (deliberately conservative — see DEC-115 D2)
 *
 * Only backtick-quoted (`` `...` ``) tokens are considered. Within a
 * backtick span, see {@link looksLikePath} and {@link looksLikeSymbolCall}
 * for the exact path/symbol shapes accepted; anything else (a shell command
 * with a space, a CLI flag, a bare number, a placeholder) is silently
 * skipped and counted in `skippedTokens`.
 *
 * **Pairing** (this is what makes "moved" answerable for a *symbol*, not
 * just a file): when a symbol-like token and a path-like token sit
 * immediately next to each other on the same line — either order, e.g. the
 * real style this project's own memory notes use, `` `incrementUsage`
 * (`piu-store.ts:119`) `` — they are treated as one reference: "this symbol
 * is expected to live in this file". Un-paired tokens are standalone
 * references (a bare path, or a bare call-shaped symbol with no expected
 * file).
 *
 * ## Path resolution and the "index root" boundary
 *
 * A reference is checked against the graph's actual indexed roots (the
 * absolute directories `egr index <dir>` was run against — read from the
 * parse-health manifest, the same SSOT `parse-manifest.ts` already keys by
 * absolute root for the same cross-repo-collision reason). A path that does
 * not fall under ANY indexed root is `unresolvable`, never `missing` — a
 * relative path like `EngramGraph/src/x.ts` written from a sibling repo's
 * docs, or an absolute/home-directory path into a repo this graph was never
 * told to index.
 *
 * When a relative reference's first path segment does not match any
 * indexed root's name, this checker makes ONE further, grounded guess
 * before giving up: does a sibling directory with that name exist on disk,
 * next to an indexed root (`join(dirname(root), firstSegment)`)? If so, this
 * is very likely a reference into a real, checked-out, but NOT indexed
 * sibling repo — `unresolvable`, not `missing`. If no such sibling exists
 * either, this checker has run out of grounded signal and falls back to
 * `missing` (after checking the filesystem and trying git rename detection).
 *
 * ## Rename detection
 *
 * A Module id not found in the graph, or a plain file not in the graph at
 * all (a config file, a doc), is checked against `git log --diff-filter=R -M
 * --name-status` in the owning root. IMPORTANT (verified empirically, not
 * assumed): this must NOT be run with a `-- <path>` pathspec — git's own
 * history-simplification collapses a rename into a plain `D`/`A` pair the
 * moment a pathspec restricts the log to that path, which silently defeats
 * `-M`. The unrestricted log is scanned in code instead, chasing a rename
 * chain (A→B→C) up to a bounded number of hops. `git` unavailable (not
 * installed, or the root is not a git repo) degrades to `missing` with a
 * reason noting renames were not checked — never silently treated as a
 * confirmed deletion. Rename detection is deliberately NOT attempted for a
 * bare filename with no directory (see point 1 above) — there is no
 * grounded way to tell git which of possibly several same-named files in
 * history is meant.
 *
 * ## Symbol resolution and ambiguity
 *
 * A bare (undotted) symbol name is looked up as both `Function` and `Class`
 * (this project's two symbol-bearing node labels). A dotted/member-call name
 * (`a.b()`) is only resolved when either the full dotted name matches
 * exactly (rare — this project's extractor stores simple names), or `a`
 * itself is a real `Class` node in the graph and `b` is a `Function` defined
 * in that same class's file — a structural stand-in for "confirmed
 * `Class.method`", since the schema has no `Class`→`Function` edge to check
 * directly. Anything else dotted (a JS/Node built-in namespace, a plain
 * variable, an unconfirmed base) is `unresolvable`, never guessed at.
 * Multiple distinct files sharing a bare name are likewise NOT guessed at —
 * DEC-115 D2 is explicit: "同名多處時不要亂猜，回報候選或 unresolvable". The one
 * exception is when the reference's OWN expected file is among the
 * candidates: that isn't a guess, it's confirming what the reference already
 * claimed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

import type { GraphConnection } from "../graph-db/connection.js";
import { toPosixPath } from "../code-graph/path-utils.js";
import { manifestPathForDb, readManifest } from "../code-graph/parse-manifest.js";
import { SKIP_DIRS } from "./walk.js";

export type RefKind = "path" | "symbol";
export type RefStatus = "present" | "moved" | "missing" | "unresolvable";

export interface RefCheckItem {
  kind: RefKind;
  /** The token exactly as it appeared inside backticks (before any normalization). */
  raw: string;
  sourceFile: string;
  sourceLine: number;
  status: RefStatus;
  /** Where it currently is (present: resolved id; moved: the new location). */
  location?: string;
  /** Set when `status === "unresolvable"` because several candidates share this name/path. */
  candidates?: string[];
  /** Always set for `missing` and `unresolvable` (DEC-115 H1 revision) — never for `present`/`moved`. */
  reason?: string;
}

export interface RefCheckResult {
  items: RefCheckItem[];
  filesScanned: string[];
  /** Backtick tokens that matched neither the path nor the symbol rule — informational only. */
  skippedTokens: number;
}

export interface RefCheckOptions {
  /** Absolute index roots. Defaults to reading them off the graph's own parse-health manifest. */
  roots?: string[];
  /** Working directory used for best-effort disk/git lookups when no root claims a reference. Defaults to `process.cwd()`. */
  cwd?: string;
}

// --- extraction ---------------------------------------------------------

const KNOWN_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
const BARE_VERSION_RE = /^v?\d+(\.\d+){1,3}$/;
/** Glob/regex/template-placeholder syntax — never a literal, checkable path. */
const NOISE_CHAR_RE = /[*?[\]^$<>{}|]/;
/** An explicit path marker: home-relative, `./`/`../`, POSIX-absolute, or a Windows drive letter. Overrides the "needs an extension" rule below — this is what still lets `~/.claude/skills` and `/abs/path` reach resolution (as `unresolvable` when out of scope) instead of being silently dropped at extraction. */
const PATH_MARKER_RE = /^(~\/|~$|\.\.?\/|\/|[A-Za-z]:[/\\])/;

/** Strip a trailing `:<line>` or `:<line>-<line>` from a path-shaped token (DEC-115 OQ-1: the line half is discarded, not verified). */
function stripLineSuffix(tok: string): string {
  const m = /^(.*):(\d+)(-\d+)?$/.exec(tok);
  if (m && KNOWN_EXT_RE.test(m[1]!)) return m[1]!;
  return tok;
}

/**
 * Is this backtick-quoted token a checkable file/directory path?
 *
 * A token WITH a leading path marker (`~/`, `./`, `../`, `/`, `C:/`) is
 * always a path — that marker is unambiguous. Otherwise it needs EITHER a
 * recognized file extension OR a trailing `/` (an explicit directory
 * mention, the convention this project's own docs/notes already use). A
 * bare multi-segment token with neither — `feat/xspec-297-…` (branch name),
 * `AsiaOstrich/EngramGraph` (`owner/repo`), `outDir/include/exclude/testDir`
 * (a word list) — is NOT a path, even though it contains `/`: this is the
 * single rule that subsumes all three of DEC-115 H1's named extraction
 * exclusions (branch names, `owner/repo`(`#N`), bare word lists), because
 * all three share the same shape (no extension, no trailing slash, no
 * marker) and none of them is a filesystem location.
 */
function looksLikePath(tok: string): boolean {
  if (tok.length === 0 || /\s/.test(tok)) return false;
  if (tok.startsWith("-")) return false; // a CLI flag, e.g. `--json`
  if (NOISE_CHAR_RE.test(tok) || tok.includes("...")) return false; // glob/regex/placeholder
  if (tok.includes("=")) return false; // `key=value`
  if (tok.includes("@")) return false; // `pkg@ver`, `@scope/pkg@ver`, or an email — never a checkable path

  const stripped = stripLineSuffix(tok);
  if (stripped.includes("(") || stripped.includes(")")) return false; // claimed by the symbol rule
  if (BARE_VERSION_RE.test(stripped)) return false;

  if (PATH_MARKER_RE.test(stripped)) return true;

  if (!stripped.includes("/")) return KNOWN_EXT_RE.test(stripped); // bare filename — still a path IF it has a real extension

  if (stripped.endsWith("/")) return true; // directory marker
  return KNOWN_EXT_RE.test(stripped); // has a real extension → path; otherwise a branch name/owner-repo/word-list → not a path
}

function looksLikeSymbolCall(tok: string): boolean {
  if (tok.includes("/")) return false;
  return /^[A-Za-z_$][\w$.]*\([^`]*\)$/.test(tok);
}

interface RawRef {
  kind: RefKind;
  raw: string;
  line: number;
  /** The raw text of the adjacent token this one was paired with (symbol↔path), if any. */
  pairedPath?: string;
}

/** Extract backtick-quoted references from one Markdown file's text. */
function extractReferences(text: string): { refs: RawRef[]; skipped: number } {
  const refs: RawRef[] = [];
  let skipped = 0;
  const lines = text.split("\n");

  lines.forEach((lineText, idx) => {
    const lineNo = idx + 1;
    const tokens: Array<{ raw: string; kind: RefKind | "skip" }> = [];
    const re = /`([^`\n]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
      const raw = m[1]!;
      if (looksLikePath(raw)) tokens.push({ raw, kind: "path" });
      else if (looksLikeSymbolCall(raw)) tokens.push({ raw, kind: "symbol" });
      else {
        tokens.push({ raw, kind: "skip" });
        skipped++;
      }
    }

    const consumed = new Set<number>();
    for (let i = 0; i < tokens.length - 1; i++) {
      if (consumed.has(i) || consumed.has(i + 1)) continue;
      const a = tokens[i]!;
      const b = tokens[i + 1]!;
      const isPair = (a.kind === "path" && b.kind === "symbol") || (a.kind === "symbol" && b.kind === "path");
      if (!isPair) continue;
      const symTok = a.kind === "symbol" ? a : b;
      const pathTok = a.kind === "path" ? a : b;
      refs.push({ kind: "symbol", raw: symTok.raw, line: lineNo, pairedPath: pathTok.raw });
      consumed.add(i);
      consumed.add(i + 1);
    }
    tokens.forEach((t, i) => {
      if (consumed.has(i) || t.kind === "skip") return;
      refs.push({ kind: t.kind, raw: t.raw, line: lineNo });
    });
  });

  return { refs, skipped };
}

// --- file discovery -------------------------------------------------------

function walkMarkdown(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
}

/** Any mix of Markdown files and directories → the list of `.md` files to check. */
function collectMarkdownFiles(inputPaths: string[]): string[] {
  const out: string[] = [];
  for (const p of inputPaths) {
    const abs = resolve(p);
    const st = statSync(abs);
    if (st.isDirectory()) walkMarkdown(abs, out);
    else out.push(abs);
  }
  return out;
}

// --- graph + git lookups ---------------------------------------------------

async function moduleExists(conn: GraphConnection, id: string): Promise<boolean> {
  const rows = await conn.query(`MATCH (m:Module {id: $id}) RETURN m.id AS id`, { id });
  return rows.length > 0;
}

async function functionLocations(conn: GraphConnection, name: string): Promise<string[]> {
  const rows = await conn.query(`MATCH (f:Function {name: $name}) RETURN DISTINCT f.file AS file`, { name });
  return rows.map((r) => String(r.file)).filter((f) => f && f !== "null");
}

async function classLocations(conn: GraphConnection, name: string): Promise<string[]> {
  const rows = await conn.query(`MATCH (c:Class {name: $name}) RETURN DISTINCT c.file AS file`, { name });
  return rows.map((r) => String(r.file)).filter((f) => f && f !== "null");
}

async function symbolLocations(conn: GraphConnection, name: string): Promise<string[]> {
  const [fnFiles, clsFiles] = await Promise.all([functionLocations(conn, name), classLocations(conn, name)]);
  return [...new Set([...fnFiles, ...clsFiles])];
}

/**
 * Where `relPath` was renamed TO, chasing a rename chain, or `null` if no
 * rename touching it was found, or `"unavailable"` if `git` itself could not
 * be run (not installed, or `repoRoot` is not a git repo).
 *
 * MUST run without a `-- <path>` pathspec — see this module's doc comment
 * for the empirically-verified reason a pathspec silently defeats `-M`.
 */
function findRenameTarget(repoRoot: string, relPath: string): string | null | "unavailable" {
  let out: string;
  try {
    out = execFileSync("git", ["-C", repoRoot, "log", "--diff-filter=R", "-M", "--name-status", "--format="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "unavailable";
  }

  const renamedFrom = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line.trim());
    if (m && !renamedFrom.has(m[1]!)) renamedFrom.set(m[1]!, m[2]!);
  }

  let current = relPath;
  const seen = new Set<string>([current]);
  for (let hop = 0; hop < 20; hop++) {
    const next = renamedFrom.get(current);
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current === relPath ? null : current;
}

/** Does a directory named `firstSeg` exist as a sibling of any indexed root? (grounded "probably another checked-out repo" signal.) */
function siblingRepoExists(roots: string[], firstSeg: string): boolean {
  for (const root of roots) {
    const candidate = join(dirname(root), firstSeg);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return true;
  }
  return false;
}

function isUnderRoot(root: string, absPath: string): boolean {
  const withSep = root.endsWith("/") ? root : `${root}/`;
  return absPath === root || absPath.startsWith(withSep);
}

function normalizePathToken(raw: string): string {
  return toPosixPath(stripLineSuffix(raw)).replace(/^\.\//, "");
}

type PartialItem = Omit<RefCheckItem, "sourceFile" | "sourceLine">;

/**
 * A path/module NOT found in the graph and NOT found on disk (both already
 * checked by the caller): the only thing left to try is a git rename.
 * `gitRoot` is the repo whose history is searched — best-effort when the
 * reference wasn't clearly root-qualified.
 */
function finishNotFoundInGraph(base: { kind: "path"; raw: string }, gitRoot: string, relPath: string): PartialItem {
  const moved = findRenameTarget(gitRoot, relPath);
  if (moved === "unavailable") {
    return { ...base, status: "missing", reason: "not found in the graph or on disk under the indexed root; git was unavailable so renames were not checked" };
  }
  if (moved) return { ...base, status: "moved", location: moved };
  return { ...base, status: "missing", reason: "not found in the graph, on disk under the indexed root, or in git rename history" };
}

/** Graph, then disk, then (as a last resort) git rename — for a reference already resolved to one specific root + relative path. */
async function resolveRelPathInRoot(conn: GraphConnection, base: { kind: "path"; raw: string }, root: string, relPath: string): Promise<PartialItem> {
  if (await moduleExists(conn, relPath)) return { ...base, status: "present", location: relPath };
  if (existsSync(join(root, relPath))) return { ...base, status: "present", location: relPath };
  return finishNotFoundInGraph(base, root, relPath);
}

/**
 * A bare filename with no directory (`App.tsx`, `graph.db`) — DEC-115 H1's
 * single largest false-`missing` bucket. There is no grounded way to say
 * "missing" here: the same basename could exist, or not, in any number of
 * places this checker was never told about. The only claims it is safe to
 * make are (a) present, when the graph or the TOP LEVEL of exactly one
 * indexed root has a file with this exact name, and (b) unresolvable
 * otherwise — never a guess, and never a git-rename attempt (chasing a
 * rename for a name with no known original directory would itself be a
 * guess about where it used to live).
 */
async function resolveBareFilename(conn: GraphConnection, normalized: string, roots: string[], cwd: string, base: { kind: "path"; raw: string }): Promise<PartialItem> {
  if (await moduleExists(conn, normalized)) return { ...base, status: "present", location: normalized };

  const searchRoots = roots.length > 0 ? roots : [cwd];
  const hits = searchRoots.filter((r) => existsSync(join(r, normalized)));
  if (hits.length === 1) return { ...base, status: "present", location: normalized };
  if (hits.length > 1) {
    return {
      ...base,
      status: "unresolvable",
      candidates: hits.map((r) => join(r, normalized)),
      reason: "a file with this name exists at the top level of more than one indexed root; cannot determine which one this reference means",
    };
  }
  return {
    ...base,
    status: "unresolvable",
    reason: "no directory was given, so this could refer to any file with this name anywhere; not enough context to check",
  };
}

async function resolvePathRef(conn: GraphConnection, ref: RawRef, roots: string[], cwd: string): Promise<PartialItem> {
  const base = { kind: "path" as const, raw: ref.raw };
  let normalized = normalizePathToken(ref.raw);

  // Expand a literal leading "~" to the real home directory so it goes
  // through the same "is this under an indexed root" check as any other
  // absolute path — home directories are almost never an indexed root, so
  // this correctly (and usually) resolves to `unresolvable`, not `missing`.
  if (normalized === "~" || normalized.startsWith("~/")) {
    normalized = toPosixPath(join(homedir(), normalized.slice(1)));
  }

  if (!normalized.includes("/")) {
    return resolveBareFilename(conn, normalized, roots, cwd, base);
  }

  if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    const matchingRoot = roots.find((r) => isUnderRoot(r, normalized));
    if (!matchingRoot) {
      return { ...base, status: "unresolvable", reason: "absolute path (or expanded ~) is not under any of this graph's indexed roots" };
    }
    const relPath = toPosixPath(relative(matchingRoot, normalized));
    return resolveRelPathInRoot(conn, base, matchingRoot, relPath);
  }

  // Relative reference: try it bare first (the common case — a doc inside
  // the same repo it's referring to, so its paths are already root-relative).
  // Checked against the graph AND the filesystem of every indexed root —
  // most non-code files (.md/.sh/.yaml/docs) are real but were never walked
  // into a Module node, so a graph-only check misses them.
  if (await moduleExists(conn, normalized)) return { ...base, status: "present", location: normalized };
  const diskRoots = roots.length > 0 ? roots : [cwd];
  if (diskRoots.some((r) => existsSync(join(r, normalized)))) return { ...base, status: "present", location: normalized };

  const firstSeg = normalized.split("/")[0]!;
  const matchedRoot = roots.find((r) => basename(r) === firstSeg);
  if (matchedRoot) {
    const stripped = normalized.split("/").slice(1).join("/");
    return resolveRelPathInRoot(conn, base, matchedRoot, stripped);
  }

  if (roots.length === 0) {
    // No manifest — single-repo mode (DEC-115 D2: no cross-repo advantage to lose here).
    return finishNotFoundInGraph(base, cwd, normalized);
  }

  if (siblingRepoExists(roots, firstSeg)) {
    return {
      ...base,
      status: "unresolvable",
      reason: `looks like a reference into "${firstSeg}", which exists on disk but is not one of this graph's indexed roots`,
    };
  }

  return finishNotFoundInGraph(base, roots[0]!, normalized);
}

/** JS/Node built-in namespaces a dotted symbol reference's base might name — never a project symbol, so never worth a graph lookup. */
const BUILTIN_NAMESPACES: ReadonlySet<string> = new Set([
  "process", "console", "JSON", "Object", "Array", "Promise", "Math", "Number", "String", "Boolean",
  "Date", "RegExp", "Map", "Set", "Symbol", "Reflect", "Error", "Buffer",
  "globalThis", "global", "window", "document",
  "os", "path", "fs", "crypto", "util", "url", "child_process",
]);

async function resolveSymbolRef(conn: GraphConnection, ref: RawRef): Promise<PartialItem> {
  const base = { kind: "symbol" as const, raw: ref.raw };
  const fullName = ref.raw.replace(/\(.*\)$/s, "");
  const expectedFile = ref.pairedPath ? normalizePathToken(ref.pairedPath) : undefined;
  const matchesExpected = (file: string): boolean =>
    expectedFile != null && (file === expectedFile || file.endsWith(`/${expectedFile}`) || expectedFile.endsWith(`/${file}`));

  const finish = (files: string[]): PartialItem => {
    if (files.length === 0) {
      if (expectedFile) {
        return { ...base, status: "missing", reason: `no Function/Class named "${fullName}" was found in the graph` };
      }
      return {
        ...base,
        status: "unresolvable",
        reason: "not found in the graph, and no accompanying file reference to confirm this names a symbol in this project (it may be a built-in or external call)",
      };
    }
    if (files.length === 1) {
      const file = files[0]!;
      if (!expectedFile || matchesExpected(file)) return { ...base, status: "present", location: file };
      return { ...base, status: "moved", location: file };
    }
    const confirmed = files.find(matchesExpected);
    if (confirmed) return { ...base, status: "present", location: confirmed };
    return {
      ...base,
      status: "unresolvable",
      candidates: files.sort(),
      reason: "multiple functions/classes share this name; cannot determine which one this reference means",
    };
  };

  if (fullName.includes(".")) {
    // A dotted/member-call reference (`a.b()`). DEC-115 H1: the round-1
    // fallback of matching just the LAST segment against any Function in
    // the graph is exactly the "same name somewhere unrelated" guess D2
    // forbids — it produced false `moved` results. There is no `Class` →
    // `Function` edge in the schema, so "confirmed Class.method" here means:
    // the base is a real `Class` node, AND the tail name is a `Function`
    // defined in that same class's file.
    const parts = fullName.split(".");
    const rootName = parts[0]!;
    const method = parts[parts.length - 1]!;

    if (BUILTIN_NAMESPACES.has(rootName)) {
      return { ...base, status: "unresolvable", reason: `"${rootName}" looks like a built-in/standard-library namespace, not a project symbol` };
    }

    let files = await symbolLocations(conn, fullName); // exact dotted name — rare, but some extractors could store it
    if (files.length === 0) {
      const classFiles = await classLocations(conn, rootName);
      if (classFiles.length === 0) {
        return {
          ...base,
          status: "unresolvable",
          reason: `"${fullName}" is a member/dotted call; "${rootName}" could not be confirmed as a class in the graph, so this may not be a project symbol`,
        };
      }
      const methodFiles = await functionLocations(conn, method);
      files = methodFiles.filter((f) => classFiles.includes(f));
      if (files.length === 0) {
        return { ...base, status: "unresolvable", reason: `"${rootName}" is a class in the graph, but "${method}" could not be confirmed as one of its methods` };
      }
    }
    return finish(files);
  }

  return finish(await symbolLocations(conn, fullName));
}

// --- entry point ------------------------------------------------------

function readRootsFromManifest(dbPath: string): string[] {
  try {
    const manifest = readManifest(manifestPathForDb(dbPath));
    return manifest ? Object.keys(manifest.runs) : [];
  } catch {
    return [];
  }
}

/**
 * Check every file-path / symbol reference in the given Markdown file(s) or
 * directory(ies) against the graph `conn` is connected to (read-only — this
 * never writes to `conn`, see this module's doc comment).
 */
export async function checkRefs(conn: GraphConnection, inputPaths: string[], opts: RefCheckOptions = {}): Promise<RefCheckResult> {
  const files = collectMarkdownFiles(inputPaths);
  const roots = opts.roots ?? readRootsFromManifest(conn.path);
  const cwd = opts.cwd ?? process.cwd();

  const items: RefCheckItem[] = [];
  let skippedTokens = 0;

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const { refs, skipped } = extractReferences(text);
    skippedTokens += skipped;
    for (const ref of refs) {
      const partial = ref.kind === "path" ? await resolvePathRef(conn, ref, roots, cwd) : await resolveSymbolRef(conn, ref);
      items.push({ ...partial, sourceFile: file, sourceLine: ref.line });
    }
  }

  return { items, filesScanned: files, skippedTokens };
}
