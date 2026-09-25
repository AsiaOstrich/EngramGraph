/**
 * `egr refs check` — verify code references cited in Markdown are still
 * accurate (DEC-115 L2, https://github.com/AsiaOstrich/dev-platform →
 * cross-project/decisions/DEC-115-memory-code-reference-check.md).
 *
 * ## What this checks, and why "unresolvable" is a real third answer
 *
 * AI memory/notes/README files cite code by file path or by symbol name.
 * Code moves; the citation doesn't update itself. A naive "does this path
 * exist" check is wrong more than it's right (DEC-115's own measurement: on
 * a real 269-note corpus, a plain existence check flagged 43 as missing and
 * a manual check of 4 of them found all 4 were false positives — the file
 * had simply MOVED). So every reference gets one of four answers, and
 * `unresolvable` is not a synonym for "missing" — it means this checker does
 * not have enough information to say either way (e.g. the reference names a
 * repo this graph was never told to index). Reporting `missing` there would
 * be a false claim of certainty this tool does not have.
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
 * Only backtick-quoted (`` `...` ``) tokens are considered; the rest of a
 * Markdown file is prose this checker has no business parsing. Within a
 * backtick span:
 *
 *   - **Path-like**: contains `/`, OR ends in `.<ext>` (so a same-directory
 *     mention like `` `package.json` `` still counts) — but NOT a bare
 *     version number (`1.30.0`) and NOT anything containing `(`/`)` (that
 *     shape is claimed by the symbol rule below instead). A trailing
 *     `:<line>` (or `:<line>-<line>`) is stripped and the remainder is
 *     treated as the path; this tool does not track whether the LINE number
 *     is still correct, only the file — see the module's `file:line` note
 *     in the DEC's OQ-1 (out of scope for this batch).
 *   - **Symbol-like**: call-shaped, `name(...)` (also matches dotted names
 *     like `console.log()`). A bare identifier with no parentheses and no
 *     path context (`` `main` ``, `` `true` ``) is intentionally NOT
 *     extracted — it is indistinguishable from an English word, and DEC-115
 *     explicitly asks for under-extraction over false positives.
 *   - Anything else in backticks (a shell command with a space, a CLI flag,
 *     a bare number) is silently skipped and counted in `skippedTokens`.
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
 * not fall under ANY indexed root is `unresolvable`, never `missing` — this
 * is the direct fix for DEC-115's own false-positive count (a relative path
 * like `EngramGraph/src/x.ts` written from a sibling repo's docs, or an
 * absolute path into a repo this graph was never told to index).
 *
 * When a relative reference's first path segment does not match any
 * indexed root's name, this checker makes ONE further, grounded guess
 * before giving up: does a sibling directory with that name exist on disk,
 * next to an indexed root (`join(dirname(root), firstSegment)`)? If so, this
 * is very likely a reference into a real, checked-out, but NOT indexed
 * sibling repo (DEC-115's measured case: 4 of 5 "missing" hits in the
 * five-repo sample were exactly this) — `unresolvable`, not `missing`. If no
 * such sibling exists either, this checker has run out of grounded signal
 * and falls back to `missing` (after trying git rename detection).
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
 * confirmed deletion.
 *
 * ## Symbol resolution and ambiguity
 *
 * A symbol name is looked up as both `Function` and `Class` (this project's
 * two symbol-bearing node labels). Multiple distinct files sharing that name
 * are NOT guessed at — DEC-115 D2 is explicit: "同名多處時不要亂猜，回報候選或
 * unresolvable". The one exception is when the reference's OWN expected file
 * is among the candidates: that isn't a guess, it's confirming what the
 * reference already claimed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

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
  /** Set when `status === "unresolvable"` because several nodes share this name. */
  candidates?: string[];
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
  /** Working directory used for best-effort git lookups when no root claims a reference. Defaults to `process.cwd()`. */
  cwd?: string;
}

// --- extraction ---------------------------------------------------------

const KNOWN_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
const BARE_VERSION_RE = /^v?\d+(\.\d+){1,3}$/;

/** Strip a trailing `:<line>` or `:<line>-<line>` from a path-shaped token (DEC-115 OQ-1: the line half is discarded, not verified). */
function stripLineSuffix(tok: string): string {
  const m = /^(.*):(\d+)(-\d+)?$/.exec(tok);
  if (m && KNOWN_EXT_RE.test(m[1]!)) return m[1]!;
  return tok;
}

function looksLikePath(tok: string): boolean {
  if (tok.length === 0 || /\s/.test(tok)) return false;
  if (tok.startsWith("-")) return false; // a CLI flag, e.g. `--json`
  const stripped = stripLineSuffix(tok);
  if (stripped.includes("(") || stripped.includes(")")) return false; // claimed by the symbol rule
  if (BARE_VERSION_RE.test(stripped)) return false;
  if (stripped.includes("/")) return true;
  return KNOWN_EXT_RE.test(stripped);
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

async function symbolLocations(conn: GraphConnection, name: string): Promise<string[]> {
  const [fnRows, clsRows] = await Promise.all([
    conn.query(`MATCH (f:Function {name: $name}) RETURN DISTINCT f.file AS file`, { name }),
    conn.query(`MATCH (c:Class {name: $name}) RETURN DISTINCT c.file AS file`, { name }),
  ]);
  const files = new Set<string>();
  for (const r of [...fnRows, ...clsRows]) {
    if (r.file != null && r.file !== "null") files.add(String(r.file));
  }
  return [...files];
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

async function resolvePathRef(conn: GraphConnection, ref: RawRef, roots: string[], cwd: string): Promise<PartialItem> {
  const base = { kind: "path" as const, raw: ref.raw };
  const normalized = normalizePathToken(ref.raw);

  const finishFromDisk = (repoRoot: string, relPath: string): PartialItem => {
    const moved = findRenameTarget(repoRoot, relPath);
    if (moved === "unavailable") {
      return { ...base, status: "missing", reason: "not found in the graph; git was unavailable so renames were not checked" };
    }
    if (moved) return { ...base, status: "moved", location: moved };
    return { ...base, status: "missing" };
  };

  if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    const matchingRoot = roots.find((r) => isUnderRoot(r, normalized));
    if (!matchingRoot) {
      return { ...base, status: "unresolvable", reason: "absolute path is not under any of this graph's indexed roots" };
    }
    const relPath = toPosixPath(relative(matchingRoot, normalized));
    if (await moduleExists(conn, relPath)) return { ...base, status: "present", location: relPath };
    return finishFromDisk(matchingRoot, relPath);
  }

  // Relative reference: try it bare first (the common case — a doc inside
  // the same repo it's referring to, so its paths are already root-relative).
  if (await moduleExists(conn, normalized)) return { ...base, status: "present", location: normalized };

  const firstSeg = normalized.split("/")[0]!;
  const matchedRoot = roots.find((r) => basename(r) === firstSeg);
  if (matchedRoot) {
    const stripped = normalized.split("/").slice(1).join("/");
    if (await moduleExists(conn, stripped)) return { ...base, status: "present", location: stripped };
    return finishFromDisk(matchedRoot, stripped);
  }

  if (roots.length === 0) {
    // No manifest — single-repo mode (DEC-115 D2: no cross-repo advantage to lose here).
    return finishFromDisk(cwd, normalized);
  }

  if (siblingRepoExists(roots, firstSeg)) {
    return {
      ...base,
      status: "unresolvable",
      reason: `looks like a reference into "${firstSeg}", which exists on disk but is not one of this graph's indexed roots`,
    };
  }

  return finishFromDisk(roots[0]!, normalized);
}

async function resolveSymbolRef(conn: GraphConnection, ref: RawRef): Promise<PartialItem> {
  const base = { kind: "symbol" as const, raw: ref.raw };
  const fullName = ref.raw.replace(/\(.*\)$/s, "");
  let files = await symbolLocations(conn, fullName);
  if (files.length === 0 && fullName.includes(".")) {
    files = await symbolLocations(conn, fullName.split(".").pop()!);
  }

  const expectedFile = ref.pairedPath ? normalizePathToken(ref.pairedPath) : undefined;
  const matchesExpected = (file: string): boolean =>
    expectedFile != null && (file === expectedFile || file.endsWith(`/${expectedFile}`) || expectedFile.endsWith(`/${file}`));

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
