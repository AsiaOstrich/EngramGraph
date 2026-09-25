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
 * ## Round 3: `missing` needs EVIDENCE it once existed, not just an absence
 *
 * Round 2 raised the real accuracy substantially but still fell short of H1
 * (28% of `missing` were real on the next full run). The remaining false
 * positives were not new noise shapes to list — the round-2 exclusion list
 * approach had reached its structural limit. The fix is a rule, not another
 * exclusion:
 *
 * **A reference is only `missing` when this checker can point to evidence it
 * once existed — a git commit, for a path; a commit that changed the
 * identifier's occurrence count, for a symbol. No such evidence →
 * `unresolvable`, however plausible the reference looks.** This makes
 * `missing`'s accuracy a property of the check's construction, not of how
 * complete an exclusion list happens to be. See {@link finishNotFoundInGraph}
 * (paths) and the symbol-evidence branch in {@link resolveSymbolRef}.
 *
 * Three smaller, related fixes shipped alongside it:
 *
 *   - **URLs** (`scheme://…`) were being extracted as paths (a domain like
 *     `…workers.dev` ends in what looks like a file extension) — excluded at
 *     extraction; see {@link looksLikePath}.
 *   - **Repo-name-prefixed relative paths** (`machine-setup/machines/…`)
 *     whose first segment names a real but UN-indexed sibling repo now
 *     resolve one level in and land on the same "sibling repo, not indexed"
 *     `unresolvable` as before — this already worked when the first segment
 *     matched an INDEXED root's name; it now also fires for an unindexed one.
 *   - **Unqualified relative paths that live inside an unindexed sibling**
 *     (a note says `machines/nb28-mac/README.md`, dropping the
 *     `machine-setup/` the citing context implied) are found by checking
 *     every sibling directory of every indexed root for that path, not just
 *     the one named by the first segment — see {@link siblingRepoContainingPath}.
 *
 * Performance: a git call per candidate is what round 2's design implied and
 * is NOT what round 3 does. Each indexed root's full set of ever-committed
 * paths is fetched ONCE (`git log --all --name-only`) and cached for the
 * whole `checkRefs` run; a candidate is checked against that in-memory set,
 * and only a CONFIRMED hit pays for a second, cheap call to find its last
 * commit. Symbol pickaxe search (`git log -S`) only runs at all for the
 * (typically much smaller) set of symbols with zero graph matches.
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
import { GRAMMARS } from "../../language-support.js";

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
/** A URL scheme (`https://…`, `ssh://…`) — never a checkable filesystem path, and a domain's TLD (`…workers.dev`) otherwise looks exactly like a file extension. */
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

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
  if (URL_SCHEME_RE.test(tok)) return false; // `https://…` etc — a domain's TLD looks like a file extension
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

/**
 * A call-shaped token whose PARENTHESIZED BODY still looks like a plain
 * argument list — not an inline code snippet quoting an expression.
 * DEC-115 H1 R4: `$(dirname $0)` (shell substitution), `filter(x => !...)`
 * (an arrow-function literal, not a call to a symbol named `filter`), and
 * `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])` (two
 * expressions joined by a comparison, matched whole by the old permissive
 * regex) were all extracted as if they named a single project symbol.
 */
function looksLikeSymbolCall(tok: string): boolean {
  if (tok.includes("/")) return false;
  if (tok.includes("...")) return false; // ellipsis placeholder
  if (tok.startsWith("$(")) return false; // shell command substitution
  const m = /^[A-Za-z_$][\w$.]*\(([^`]*)\)$/.exec(tok);
  if (!m) return false;
  const body = m[1]!;
  if (body.includes("=>")) return false; // an arrow-function literal, not a call
  if (body.includes("===") || body.includes("!==")) return false; // a comparison expression, not a single call
  if (/['"]/.test(body)) return false; // a string-literal argument — usually quoted example code, not a symbol reference
  return true;
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
/**
 * Per-`checkRefs`-run cache of each root's full rename-record map (DEC-115
 * H1 R6) — same reasoning as {@link HistoryCache}: one `git log` call per
 * repo, not one per candidate (this used to re-run the same query for
 * every candidate that needed it; now it shares the map the way
 * `historyPathSet` already shared history).
 */
type RenameCache = Map<string, Map<string, string> | "unavailable">;

/** Every `oldPath → newPath` rename record in `repoRoot`'s full history, cached. MUST run without a `-- <path>` pathspec — see this module's doc comment for the empirically-verified reason a pathspec silently defeats `-M`. */
function renamesForRoot(repoRoot: string, cache: RenameCache): Map<string, string> | "unavailable" {
  const cached = cache.get(repoRoot);
  if (cached) return cached;
  let result: Map<string, string> | "unavailable";
  try {
    const out = execFileSync("git", ["-C", repoRoot, "log", "--diff-filter=R", "-M", "--name-status", "--format="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const map = new Map<string, string>();
    for (const line of out.split("\n")) {
      const m = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line.trim());
      if (m && !map.has(m[1]!)) map.set(m[1]!, m[2]!);
    }
    result = map;
  } catch {
    result = "unavailable";
  }
  cache.set(repoRoot, result);
  return result;
}

function findRenameTarget(repoRoot: string, relPath: string, cache: RenameCache): string | null | "unavailable" {
  const renamedFrom = renamesForRoot(repoRoot, cache);
  if (renamedFrom === "unavailable") return "unavailable";

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

/**
 * DEC-115 H1 R6 item 1: the directory counterpart of {@link findRenameTarget}.
 * Git only ever records file renames, never a directory rename as such — a
 * directory move is N individual file-rename records that happen to share a
 * prefix. `moved` is reported only when EVERY renamed file whose OLD path
 * sat under `dirPrefix` maps to a NEW path under the exact same single new
 * prefix — a genuine, consistent directory move. Anything less consistent
 * (some files moved elsewhere, some not renamed at all) returns `null` — per
 * DEC-115 H1 R6: "能判才判，不能判就 missing", not a guess.
 */
function directoryRenameTarget(repoRoot: string, dirPrefix: string, cache: RenameCache): string | null | "unavailable" {
  const renamedFrom = renamesForRoot(repoRoot, cache);
  if (renamedFrom === "unavailable") return "unavailable";

  const prefix = dirPrefix.endsWith("/") ? dirPrefix : `${dirPrefix}/`;
  const newPrefixes = new Set<string>();
  let anyMatch = false;
  for (const [oldPath, newPath] of renamedFrom) {
    if (!oldPath.startsWith(prefix)) continue;
    anyMatch = true;
    const suffix = oldPath.slice(prefix.length);
    if (!newPath.endsWith(suffix)) {
      return null; // this one file's rename doesn't fit a whole-directory move — can't determine
    }
    newPrefixes.add(newPath.slice(0, newPath.length - suffix.length));
  }
  if (!anyMatch || newPrefixes.size !== 1) return null;
  return [...newPrefixes][0]!;
}

/** Does ANY path in `history` sit under `dirPrefix`? Git only records files, never directories, so a directory's "existence" in history is this prefix scan over the same file-path set {@link historyPathSet} already collects. */
function directoryEverExisted(history: Set<string>, dirPrefix: string): boolean {
  const prefix = dirPrefix.endsWith("/") ? dirPrefix : `${dirPrefix}/`;
  for (const p of history) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

/** The most recent commit touching anything under `dirPrefix` — a trailing-slash pathspec, verified empirically to match every file below it. */
function lastSeenCommitForDir(repoRoot: string, dirPrefix: string): string | null {
  const prefix = dirPrefix.endsWith("/") ? dirPrefix : `${dirPrefix}/`;
  try {
    const out = execFileSync("git", ["-C", repoRoot, "log", "--all", "--format=%h", "-1", "--", prefix], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Does a directory named `firstSeg` exist as a sibling of any indexed root? (grounded "probably another checked-out repo" signal.) */
function siblingRepoExists(roots: string[], firstSeg: string): boolean {
  for (const root of roots) {
    const candidate = join(dirname(root), firstSeg);
    // DEC-115 H1 R5: an index root whose OWN basename equals `firstSeg`
    // (the real shape — `vibeops/src` for a citation starting `src/…`) makes
    // `candidate` equal that SAME already-indexed root, not a sibling of it.
    // Without this guard, an index root is reported as its own un-indexed
    // sibling — wrong in the specific, structural way this round's
    // `matchedRoot` fix could otherwise be shadowed by.
    if (roots.includes(candidate)) continue;
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return true;
  }
  return false;
}

/**
 * DEC-115 H1 round 3: the un-qualified counterpart of {@link siblingRepoExists}.
 * A citing note often drops the repo-name prefix its own context implied
 * (`machines/nb28-mac/README.md`, not `machine-setup/machines/nb28-mac/…`),
 * so this checks whether `relPath` itself exists inside ANY sibling
 * directory of any indexed root — not just one named by the reference's
 * first segment. Returns that sibling's directory name, or `undefined`.
 */
function siblingRepoContainingPath(roots: string[], relPath: string): string | undefined {
  const parents = new Set(roots.map((r) => dirname(r)));
  for (const parent of parents) {
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(parent, name);
      if (roots.includes(dir)) continue; // already an indexed root — handled elsewhere
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(dir, relPath))) return name;
    }
  }
  return undefined;
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
 * Per-`checkRefs`-run cache of `indexRoot → git toplevel` (DEC-115 H1 R5).
 * Never module-level — same reasoning as {@link HistoryCache}.
 */
type ToplevelCache = Map<string, string>;

/**
 * `git -C <dir> rev-parse --show-toplevel` — the real repo root, realpath
 * resolved (so a symlinked index root, e.g. `dev-platform/vibeops`, and its
 * real target agree). Falls back to `dir` itself when `dir` is not inside a
 * git repo (or `git` is unavailable) — this checker still works, just
 * without the toplevel/index-root distinction (nothing to distinguish).
 */
function gitToplevel(dir: string, cache: ToplevelCache): string {
  const cached = cache.get(dir);
  if (cached) return cached;
  let result: string;
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    result = out.length > 0 ? out : dir;
  } catch {
    result = dir;
  }
  cache.set(dir, result);
  return result;
}

/**
 * DEC-115 H1 R5's core fix. `roots` (from the parse-health manifest) are
 * `egr index <dir>` call sites — frequently a SUBDIRECTORY of a repo, not
 * its root (dev-platform's real manifest: `vibeops/src`, `vibeops/scripts`,
 * …, each its own index root, all inside the ONE `vibeops` repo). But:
 *
 *   - `git log`'s output (rename targets, `--name-only` history, commit
 *     hashes via `-- <path>` pathspecs) is always REPO-ROOT-relative — `git
 *     -C <subdir>` changes where git RUNS, not the coordinate system its
 *     answers are reported in, and a `-- <path>` pathspec is resolved
 *     relative to that same cwd, so a subdirectory root silently shifts
 *     pathspec-based lookups (`lastSeenCommit`) onto the wrong file even
 *     when unrestricted lookups (`historyPathSet`, no pathspec) still
 *     happen to return correct, repo-wide, repo-root-relative data.
 *   - A memory note is usually written AS IF standing at the repo it
 *     describes, so its paths (`src/license/index.ts`) are already
 *     REPO-ROOT-relative, not relative to whatever subdirectory happened to
 *     be indexed.
 *
 * So this returns EVERY (toplevel, repo-relative-path) pair worth trying
 * for `normalized`, deduplicated across all `roots`: the path taken as
 * literally repo-root-relative already (the common case), AND the path
 * taken as relative to each index root, converted to repo-root-relative via
 * that root's offset from its own toplevel (the case an index root's
 * `basename` used to be mistaken for a "repo name" to strip — see round 3's
 * `matchedRoot`, which still exists for the GRAPH's Module-id lookup, a
 * genuinely different, index-root-relative coordinate system).
 */
function repoRelativeCandidates(roots: string[], normalized: string, topCache: ToplevelCache): Array<{ toplevel: string; repoRelativePath: string }> {
  const out: Array<{ toplevel: string; repoRelativePath: string }> = [];
  const seen = new Set<string>();
  const push = (toplevel: string, repoRelativePath: string): void => {
    const key = `${toplevel}\u0000${repoRelativePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ toplevel, repoRelativePath });
  };
  for (const root of roots) {
    const toplevel = gitToplevel(root, topCache);
    push(toplevel, normalized); // already repo-root-relative (the common case)
    if (toplevel !== root) {
      const offset = toPosixPath(relative(toplevel, root));
      push(toplevel, toPosixPath(join(offset, normalized))); // index-root-relative, converted
    }
  }
  return out;
}

/**
 * Per-`checkRefs`-run cache of each root's full historical path set (DEC-115
 * H1 round 3). Built fresh in {@link checkRefs} and threaded through — never
 * module-level, so nothing here persists between runs or leaks across tests
 * using different fixture repos at coincidentally-reused paths.
 */
type HistoryCache = Map<string, Set<string> | "unavailable">;

/**
 * Every path ANY commit in `repoRoot`'s full history ever touched (added,
 * modified, deleted, or the source/target of a rename) — one `git log`
 * call, cached, and then a plain Set membership check per candidate. This is
 * the batching DEC-115 H1 R3 asks for: checking hundreds of `missing`
 * candidates against a per-root call each, not a call each.
 */
function historyPathSet(repoRoot: string, cache: HistoryCache): Set<string> | "unavailable" {
  const cached = cache.get(repoRoot);
  if (cached) return cached;
  let result: Set<string> | "unavailable";
  try {
    const out = execFileSync("git", ["-C", repoRoot, "log", "--all", "--name-only", "--format="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    result = new Set(out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
  } catch {
    result = "unavailable";
  }
  cache.set(repoRoot, result);
  return result;
}

/** The most recent commit that touched `relPath` — only called for a CONFIRMED history hit, so this is a small, bounded number of extra calls, not one per candidate. */
function lastSeenCommit(repoRoot: string, relPath: string): string | null {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "log", "--all", "--format=%h", "-1", "--", relPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * A path/module NOT found in the graph and NOT found on disk (both already
 * checked by the caller). DEC-115 H1 R3's core rule: `missing` requires
 * EVIDENCE this path once existed, not just its current absence — a rename
 * (checked first, since that's a stronger, more specific claim) or a plain
 * appearance anywhere in history. No evidence at all → `unresolvable`,
 * however plausible the reference looks.
 *
 * `candidateRoots` — DEC-115 H1 R4's fix: a reference isn't always clearly
 * root-qualified (e.g. a note written from inside a sub-repo just says
 * `src/license/index.ts`, no `vibeops/` prefix), and dev-platform's graph
 * indexes SEVERAL git repos under separate roots (each sub-project symlinked
 * in, each with its own `.git`). Checking only ONE root's history — round 3's
 * bug — silently missed every real deletion in every OTHER indexed repo:
 * the round-3 rerun found 51 confirmed-real deletions in sub-repos, all
 * reported `unresolvable` because only one (arbitrary) root was ever
 * checked. Every candidate root is tried, in order, for both rename and
 * history evidence; the first hit wins.
 */
/**
 * DEC-115 H1 R6: evidence lookup, split out from the final "declare
 * unresolvable" fallback (previously one function) so callers can try
 * OTHER signals — the un-indexed-sibling heuristics — only when evidence
 * genuinely comes up empty, not before. Round 6's item 2 bug was exactly
 * this ordering: a sibling directory coincidentally named "scripts" was
 * reported before this evidence check ever ran, even though the reference
 * was sitting right there in an INDEXED repo's own history.
 *
 * Directory-aware (item 1): a candidate whose `repoRelativePath` ends in
 * `/` is checked as a directory — history membership becomes "any path
 * under this prefix", and rename detection becomes "every renamed file
 * under this prefix landed under the same single new prefix" (see
 * {@link directoryRenameTarget}) — since git records only file renames,
 * never a directory rename as such.
 *
 * Returns `null` when there is truly no evidence anywhere (and git was
 * available everywhere it was asked) — the caller decides what to do next.
 */
/**
 * Three genuinely different outcomes, not two (DEC-115 H1 R6): `found` is a
 * real positive hit (rename or history membership) and must outrank a
 * sibling-repo GUESS. `unavailable` (git couldn't be run at all for any
 * candidate) is NOT evidence of anything — it must NOT outrank the sibling
 * guess either, or a fixture/environment with no real git repo would report
 * `missing` before ever trying the sibling heuristics that used to catch it
 * (this is exactly what broke when `anyUnavailable` first tried to double as
 * "no evidence" here). `not-found` means every candidate WAS checked and
 * came back clean.
 */
type EvidenceResult = { kind: "found"; item: PartialItem } | { kind: "unavailable" } | { kind: "not-found" };

function findEvidence(
  base: { kind: "path"; raw: string },
  candidates: Array<{ toplevel: string; repoRelativePath: string }>,
  cache: HistoryCache,
  renameCache: RenameCache,
): EvidenceResult {
  let anyUnavailable = false;

  for (const { toplevel, repoRelativePath } of candidates) {
    const isDir = repoRelativePath.endsWith("/");
    const moved = isDir ? directoryRenameTarget(toplevel, repoRelativePath, renameCache) : findRenameTarget(toplevel, repoRelativePath, renameCache);
    if (moved === "unavailable") {
      anyUnavailable = true;
      continue;
    }
    if (moved) {
      // DEC-115 H1 R7: a rename chain's END is not guaranteed to still be
      // there — a file (or directory) can move once, then be deleted at
      // its new location, and `findRenameTarget`/`directoryRenameTarget`
      // only ever chase the CHAIN, they never checked whether the chain's
      // last stop still exists. Reporting `moved` to a location that is
      // ALSO gone is a wrong answer, not a partial one — the correct
      // status for "moved, then removed" is `missing`, with a reason that
      // names both events instead of silently collapsing them into a
      // `moved` a caller would then go look for and not find.
      if (existsSync(join(toplevel, moved))) {
        return { kind: "found", item: { ...base, status: "moved", location: moved } };
      }
      const commit = isDir ? lastSeenCommitForDir(toplevel, moved) : lastSeenCommit(toplevel, moved);
      return {
        kind: "found",
        item: {
          ...base,
          status: "missing",
          reason: commit
            ? `moved to "${moved}" and later removed there; last appears in git history at commit ${commit}`
            : `moved to "${moved}", which no longer exists there either, but its own last commit could not be determined`,
        },
      };
    }
  }

  for (const { toplevel, repoRelativePath } of candidates) {
    const history = historyPathSet(toplevel, cache);
    if (history === "unavailable") {
      anyUnavailable = true;
      continue;
    }
    const isDir = repoRelativePath.endsWith("/");
    const found = isDir ? directoryEverExisted(history, repoRelativePath) : history.has(repoRelativePath);
    if (found) {
      // Same (toplevel, repoRelativePath) pair the membership check just
      // matched on — DEC-115 H1 R5's bug 2: computing this against the
      // wrong root/coordinate returned nothing even on a confirmed hit
      // ("last commit could not be determined"), because `-- <path>` is a
      // pathspec, and a pathspec IS resolved relative to `-C`'s cwd.
      const commit = isDir ? lastSeenCommitForDir(toplevel, repoRelativePath) : lastSeenCommit(toplevel, repoRelativePath);
      return {
        kind: "found",
        item: {
          ...base,
          status: "missing",
          reason: commit ? `no longer exists; last appears in git history at commit ${commit}` : "no longer exists; found in git history but its last commit could not be determined",
        },
      };
    }
  }

  return anyUnavailable ? { kind: "unavailable" } : { kind: "not-found" };
}

/** `findEvidence`'s final fallback, when there is no sibling-repo nuance to weigh (single-repo/no-manifest mode) — `unavailable` and `not-found` collapse to their respective terminal answers straightaway. */
function finishNotFoundInGraph(
  base: { kind: "path"; raw: string },
  candidates: Array<{ toplevel: string; repoRelativePath: string }>,
  cache: HistoryCache,
  renameCache: RenameCache,
): PartialItem {
  const evidence = findEvidence(base, candidates, cache, renameCache);
  if (evidence.kind === "found") return evidence.item;
  if (evidence.kind === "unavailable") {
    return {
      ...base,
      status: "missing",
      reason: "not found in the graph or on disk under any indexed root; git was unavailable for at least one of them so history could not be fully checked",
    };
  }
  return {
    ...base,
    status: "unresolvable",
    reason: "never appears in any indexed root's git history — not enough evidence this was ever a real path here",
  };
}

/** Graph, then disk, then (as a last resort) git evidence — for a reference already resolved to one specific root + relative path. */
async function resolveRelPathInRoot(
  conn: GraphConnection,
  base: { kind: "path"; raw: string },
  root: string,
  relPath: string,
  cache: HistoryCache,
  topCache: ToplevelCache,
  renameCache: RenameCache,
): Promise<PartialItem> {
  // Graph: Module ids are INDEX-ROOT-relative (egr index <dir> walks from
  // <dir>), so `relPath` (already stripped to be relative to `root`) is the
  // right coordinate here, unchanged from round 3.
  if (await moduleExists(conn, relPath)) return { ...base, status: "present", location: relPath };
  if (existsSync(join(root, relPath))) return { ...base, status: "present", location: relPath };
  // Disk/git evidence: repo-root coordinate (DEC-115 H1 R5) — `relPath` here
  // might ALSO already be repo-root-relative on its own (the absolute-path
  // branch's relPath, or a citation that happened not to need `matchedRoot`
  // stripping), so both interpretations are tried via the same helper used
  // for the fully-unqualified fallback.
  return finishNotFoundInGraph(base, repoRelativeCandidates([root], relPath, topCache), cache, renameCache);
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

async function resolvePathRef(
  conn: GraphConnection,
  ref: RawRef,
  roots: string[],
  cwd: string,
  cache: HistoryCache,
  topCache: ToplevelCache,
  renameCache: RenameCache,
): Promise<PartialItem> {
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
    return resolveRelPathInRoot(conn, base, matchingRoot, relPath, cache, topCache, renameCache);
  }

  // Relative reference: try it bare first (the common case — a doc inside
  // the same repo it's referring to, so its paths are already root-relative).
  // Checked against the graph in INDEX-ROOT coordinates first (Module ids
  // come from `egr index <dir>`'s own walk, so `normalized` as literally
  // given is the right coordinate there). A directory reference (trailing
  // `/`) is never a Module id, so this is a harmless no-op for it.
  if (await moduleExists(conn, normalized)) return { ...base, status: "present", location: normalized };

  const firstSeg = normalized.split("/")[0]!;
  const matchedRoot = roots.find((r) => basename(r) === firstSeg);
  let stripped: string | undefined;
  if (matchedRoot) {
    // Round 3 rule: first segment names an INDEXED root's basename. Try the
    // GRAPH one level in (index-root-relative, unchanged) — its evidence
    // counterpart is folded into `candidates` below via `matchedRoot`'s own
    // repo-relative candidates, not a separate check.
    stripped = normalized.split("/").slice(1).join("/");
    if (await moduleExists(conn, stripped)) return { ...base, status: "present", location: stripped };
  }

  // DEC-115 H1 R5: disk existence and all git evidence run in REPO-ROOT
  // coordinates from here on — see {@link repoRelativeCandidates}'s doc
  // comment for why an index root being a subdirectory (the common real
  // shape) makes this a different coordinate system from the graph's.
  // Two independent transforms feed this, both needed (round 5's actual
  // bug was conflating them): `normalized` tried against every root's own
  // toplevel/offset, AND — when the reference is explicitly repo-prefixed
  // (`matchedRoot`) — `stripped` tried against THAT root specifically.
  const evidenceRoots = roots.length > 0 ? roots : [cwd];
  const candidates = repoRelativeCandidates(evidenceRoots, normalized, topCache);
  if (matchedRoot && stripped !== undefined) {
    candidates.push(...repoRelativeCandidates([matchedRoot], stripped, topCache));
  }
  const diskHit = candidates.find((c) => existsSync(join(c.toplevel, c.repoRelativePath)));
  if (diskHit) return { ...base, status: "present", location: diskHit.repoRelativePath };

  if (roots.length === 0) {
    // No manifest — single-repo mode (DEC-115 D2: no cross-repo advantage to lose here).
    return finishNotFoundInGraph(base, candidates, cache, renameCache);
  }

  // DEC-115 H1 R6 item 2: evidence FIRST, un-indexed-sibling guesswork
  // second. Round 5's order tried `siblingRepoExists`/`siblingRepoContainingPath`
  // BEFORE ever checking this indexed repo's own history — so a reference
  // like `scripts/setup-hooks.sh`, genuinely present in an INDEXED repo's
  // history, was reported as "looks like a reference into scripts, which
  // ... is not one of this graph's indexed roots" the moment SOME unrelated
  // directory named "scripts" happened to sit next to an indexed root
  // ("scripts" is an extremely common directory name). An indexed repo's
  // own evidence must win over a coincidental sibling-name match.
  const evidence = findEvidence(base, candidates, cache, renameCache);
  if (evidence.kind === "found") return evidence.item;

  // Round 3 rule (continued): first segment names a real but UN-indexed
  // sibling repo — same "not in scope" answer as an indexed one. Tried
  // only now — evidence.kind is "unavailable" or "not-found", never "found".
  if (siblingRepoExists(roots, firstSeg)) {
    return {
      ...base,
      status: "unresolvable",
      reason: `looks like a reference into "${firstSeg}", which exists on disk but is not one of this graph's indexed roots`,
    };
  }

  // Round 3 rule 4: no repo-name prefix at all, but the path exists inside
  // SOME un-indexed sibling anyway — the citing context likely implied the
  // repo name and the note dropped it.
  const siblingHit = siblingRepoContainingPath(roots, normalized);
  if (siblingHit) {
    return {
      ...base,
      status: "unresolvable",
      reason: `found on disk inside the "${siblingHit}" repo, which is not one of this graph's indexed roots`,
    };
  }

  if (evidence.kind === "unavailable") {
    return {
      ...base,
      status: "missing",
      reason: "not found in the graph or on disk under any indexed root; git was unavailable for at least one of them so history could not be fully checked",
    };
  }
  return {
    ...base,
    status: "unresolvable",
    reason: "never appears in any indexed root's git history — not enough evidence this was ever a real path here",
  };
}

/** JS/Node built-in namespaces a dotted symbol reference's base might name — never a project symbol, so never worth a graph lookup. */
const BUILTIN_NAMESPACES: ReadonlySet<string> = new Set([
  "process", "console", "JSON", "Object", "Array", "Promise", "Math", "Number", "String", "Boolean",
  "Date", "RegExp", "Map", "Set", "Symbol", "Reflect", "Error", "Buffer",
  "globalThis", "global", "window", "document",
  "os", "path", "fs", "crypto", "util", "url", "child_process",
  // Test-framework/platform globals (DEC-115 H1 R5 item 4) — same category
  // as the JS/Node built-ins above, checked here too since `vi.fn()`/
  // `jest.mock()` are dotted just like `os.tmpdir()`.
  "vi", "jest",
]);

/**
 * Test-framework/platform globals used BARE (undotted) — `expect`,
 * `describe`, `it`, `fetch`, and any `mock*`-prefixed Vitest/Jest mock
 * method (`mockImplementation`, `mockImplementationOnce`,
 * `mockReturnValue`, …). DEC-115 H1 R5 item 4: these are never a project
 * symbol, so — same treatment as {@link BUILTIN_NAMESPACES} — checked
 * BEFORE any graph lookup or git-evidence search, not after.
 */
const BARE_TEST_FRAMEWORK_GLOBALS: ReadonlySet<string> = new Set(["expect", "describe", "it", "fetch"]);

function isBareTestFrameworkGlobal(name: string): boolean {
  return BARE_TEST_FRAMEWORK_GLOBALS.has(name) || name.startsWith("mock");
}

/**
 * DEC-115 H1 R3: the symbol counterpart of {@link finishNotFoundInGraph}'s
 * evidence rule. `git log -S<name>` (pickaxe) finds the most recent commit
 * that changed `name`'s literal occurrence count in `root`'s history — a
 * real definition being added or removed changes that count; a name that
 * was never there does not. Only called when the graph already has zero
 * matches, so — unlike path history — this is never batched: the candidate
 * volume at that point is small (DEC-115 H1's baseline: tens, not hundreds).
 */
/**
 * `git log`'s pathspec argument list restricting a search to source-code
 * files — derived from {@link GRAMMARS} (the same registry `run.ts`'s
 * `CODE_EXTS` derives from), not hand-maintained, so this list can't drift
 * from the languages EGR actually indexes.
 */
const CODE_PATHSPECS: readonly string[] = GRAMMARS.flatMap((g) => g.extensions).map((ext) => `*${ext}`);

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A `git log -G` pattern matching common DEFINITION shapes for `name` —
 * NOT a call site or a prose mention. POSIX extended-regex syntax only (no
 * `\s`/`\b`/`\d` — empirically verified NOT to match under git's default
 * `-G` engine; `[[:space:]]` and an explicit `[^A-Za-z0-9_]` boundary class
 * are the portable equivalents).
 *
 * DEC-115 H1 R4: this is the fix for round 3's `-S` (plain occurrence-count
 * pickaxe), which matched ANY text containing the name — a mere MENTION in
 * a memory note or a doc, or a CALL site, counted the same as a real
 * definition. The round-3 rerun's false `missing` were almost entirely this:
 * `$(dirname $0)`, `setLoading(false)`, `createHash('sha256')`,
 * `fileURLToPath(...)` all "existed" by that measure. None of them is a
 * definition of a project symbol.
 */
function definitionPattern(name: string): string {
  const n = escapeRegExpLiteral(name);
  const boundaryBefore = "(^|[^A-Za-z0-9_])";
  const boundaryAfter = "([^A-Za-z0-9_]|$)";
  return [
    `${boundaryBefore}(function|fn|func|def|class)[[:space:]]+${n}${boundaryAfter}`, // function NAME / fn NAME / func NAME / def NAME / class NAME
    `${boundaryBefore}${n}[[:space:]]*=[[:space:]]*\\(`, // NAME = (...) =>  or  NAME = function
    `${boundaryBefore}${n}[[:space:]]*\\([^)]*\\)[[:space:]]*\\{`, // NAME(...) {   (method/function shorthand)
    `${boundaryBefore}${n}[[:space:]]*:[[:space:]]*function`, // NAME: function (...) {
  ].join("|");
}

/**
 * Evidence a symbol was once DEFINED somewhere in an indexed root's history
 * — `git log -G<definition pattern>`, restricted to source-code paths
 * ({@link CODE_PATHSPECS}) so a `.md`/`.yaml` mention can never count. Only
 * called when the graph already found zero matches (see the lazy call site
 * in {@link resolveSymbolRef}), so this is never batched — the candidate
 * volume at that point is small.
 */
function symbolEverExisted(roots: string[], cwd: string, name: string): { root: string; commit: string } | null | "unavailable" {
  const searchRoots = roots.length > 0 ? roots : [cwd];
  const pattern = definitionPattern(name);
  let sawUnavailable = false;
  for (const root of searchRoots) {
    try {
      const out = execFileSync(
        "git",
        ["-C", root, "log", "--all", "-G", pattern, "--format=%h", "-1", "--", ...CODE_PATHSPECS],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (out.length > 0) return { root, commit: out };
    } catch {
      sawUnavailable = true;
    }
  }
  return sawUnavailable ? "unavailable" : null;
}

async function resolveSymbolRef(conn: GraphConnection, ref: RawRef, roots: string[], cwd: string): Promise<PartialItem> {
  const base = { kind: "symbol" as const, raw: ref.raw };
  const fullName = ref.raw.replace(/\(.*\)$/s, "");
  const expectedFile = ref.pairedPath ? normalizePathToken(ref.pairedPath) : undefined;
  const matchesExpected = (file: string): boolean =>
    expectedFile != null && (file === expectedFile || file.endsWith(`/${expectedFile}`) || expectedFile.endsWith(`/${file}`));

  // DEC-115 H1 R3: `missing` requires evidence this symbol once existed —
  // a commit that changed its occurrence count in some indexed root's
  // history. This REPLACES the round-2 rule ("has an expected file → missing,
  // else unresolvable"): that heuristic is exactly what let built-ins,
  // other-language functions in un-indexed repos, and test-framework calls
  // through as false `missing` whenever they happened to sit next to an
  // unrelated path citation on the same line. Looked up LAZILY — only when
  // the graph already found zero matches — both for cost (a `git log -S`
  // call is not free) and because it is meaningless when the symbol already
  // resolved.
  const lookupName = fullName.includes(".") ? fullName.split(".").pop()! : fullName;

  const finish = (files: string[]): PartialItem => {
    if (files.length === 0) {
      const evidence = symbolEverExisted(roots, cwd, lookupName);
      if (evidence === "unavailable") {
        return { ...base, status: "missing", reason: "no Function/Class with this name was found in the graph; git was unavailable so its history could not be checked" };
      }
      if (evidence) {
        return {
          ...base,
          status: "missing",
          reason: `no longer defined anywhere in the graph; last appears in "${evidence.root}"'s git history at commit ${evidence.commit}`,
        };
      }
      return {
        ...base,
        status: "unresolvable",
        reason: "not found in the graph, and no evidence in any indexed root's git history that this was ever a defined symbol here (it may be a built-in or external call)",
      };
    }
    if (files.length === 1) {
      const file = files[0]!;
      if (!expectedFile || matchesExpected(file)) return { ...base, status: "present", location: file };
      // DEC-115 H1 R7 (checked, not changed): unlike a path's `moved`,
      // `file` here comes from a LIVE `symbolLocations` graph query, not a
      // chased historical rename chain — so it cannot point at a location
      // that has since stopped existing; the round-7 bug (a rename chain's
      // end no longer existing) has no symbol-side counterpart to fix.
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

  if (isBareTestFrameworkGlobal(fullName)) {
    return { ...base, status: "unresolvable", reason: `"${fullName}" looks like a test-framework/platform global, not a project symbol` };
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
  // Fresh per call (DEC-115 H1 R3/R5/R6) — see HistoryCache's/ToplevelCache's/
  // RenameCache's doc comments for why none of them is ever module-level.
  const historyCache: HistoryCache = new Map();
  const topCache: ToplevelCache = new Map();
  const renameCache: RenameCache = new Map();

  const items: RefCheckItem[] = [];
  let skippedTokens = 0;

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const { refs, skipped } = extractReferences(text);
    skippedTokens += skipped;
    for (const ref of refs) {
      const partial =
        ref.kind === "path"
          ? await resolvePathRef(conn, ref, roots, cwd, historyCache, topCache, renameCache)
          : await resolveSymbolRef(conn, ref, roots, cwd);
      items.push({ ...partial, sourceFile: file, sourceLine: ref.line });
    }
  }

  return { items, filesScanned: files, skippedTokens };
}
