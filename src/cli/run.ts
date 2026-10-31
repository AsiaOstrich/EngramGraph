/**
 * CLI command logic — thin wrappers over the existing public API, kept
 * separate from arg parsing (src/cli/index.ts) so they are unit-testable.
 * Each function takes an open {@link GraphConnection} and returns plain data;
 * the entry point handles I/O, formatting and process lifecycle.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import pkg from "../../package.json" with { type: "json" };
import type { GraphConnection } from "../graph-db/connection.js";
import type { ProjectFile, ProjectIndexResult } from "../code-graph/types.js";
import { clearGraph } from "../graph-db/schema.js";
import { writeFragment } from "../graph-db/writer.js";
import { gitBranchEngramDir, listBranches, sanitizeBranch } from "../graph-db/git-branch.js";
import {
  indexProject,
  extractProjectDetailed,
  moduleIdOf,
  type DetailedProjectExtraction,
  callers,
  callees,
  definitionScope,
  implementers,
  implementedSpecs,
  NotInGraphError,
  requireFunction,
  requireNode,
  requireSpec,
  suggestModules,
  suggestSpecs,
  type CallNode,
  type DefinitionScope,
  type ImplementersResult,
  type ImplementedSpecsResult,
} from "../code-graph/index.js";
import { readScipIndex } from "../code-graph/providers/scip/scip-reader.js";
import { ingestScipIndex, type ScipIngestStats, type ScipSourceFile } from "../code-graph/providers/scip/scip-ingest.js";
import { indexKnowledgeDocs, impactAnalysis, lintKnowledgeDocs, type KnowledgeIndexResult, type KnowledgeDoc, type LintReport } from "../knowledge-graph/index.js";
import { applyFeedback, feedbackForEventType, topByConfidence, type ConfidenceLabel } from "../sage/index.js";
import { godNodes, communities, related, type GodNode, type CommunityMember, type RelatedNode } from "../structural-memory/index.js";
import {
  allFiles,
  diffRuns,
  isHealthy,
  manifestPathForDb,
  readManifest,
  summarize,
  upsertRun,
  writeManifest,
  type ParseHealthSummary,
} from "../code-graph/parse-manifest.js";
import {
  applyDelta,
  dropRootState,
  fingerprint,
  gitChangedPaths,
  inspectState,
  newToken,
  readState,
  statePathForManifest,
  STATE_VERSION,
  usableState,
  writeState,
  type IncrementalState,
  type RootState,
} from "../code-graph/incremental.js";
import { assignIds, type IdAssignment } from "../code-graph/root-ids.js";
import { walkFiles, summarizeUnindexed, type ExcludedByPattern, type UnindexedSummary } from "./walk.js";
import { compileExcludes, type ExcludeMatcher } from "./exclude.js";
import { msysPathConversionHint } from "./index-hints.js";
import { canonicalFilePath, toPosixPath } from "../code-graph/path-utils.js";
import { checkRefs, type RefCheckResult } from "./refs-check.js";
import { ALGO_BACKED_COMMAND_LIST, describeAlgoSource, type AlgoSource } from "../structural-memory/algo-extension.js";
import { unavailableGrammars } from "../code-graph/grammar-registry.js";
import { GRAMMARS, compiledFromSourceOn, currentPlatform } from "../../language-support.js";
import type { SupportedLanguage } from "../code-graph/types.js";

const EGR_VERSION = (pkg as { version: string }).version;

/**
 * Extensions `egr index` walks for source code. Derived from
 * `language-support.js`'s `GRAMMARS[].extensions` (XSPEC-414 R1) rather than
 * hand-maintained — this used to be a second, independently-typed list of the
 * same facts `GRAMMARS` already states, which is exactly the drift XSPEC-365
 * R4 built the registry to prevent everywhere else. See
 * `test/language-support.test.ts`'s "CODE_EXTS is derived from
 * language-support.js" test, which fails on a structural check (does this
 * declaration reference `GRAMMARS`, does it spell out extension literals) —
 * not a value-equality check — specifically so reverting to a hand-typed
 * list (even one that happens to still be correct) is caught, not just a
 * hand-typed list that drifted out of sync.
 */
export const CODE_EXTS: readonly string[] = Object.freeze(
  GRAMMARS.flatMap((g) => [...g.extensions]),
);

export interface IndexResultSummary {
  /**
   * Everything `indexProject` returns except the bulky per-file array — derived
   * from `ProjectIndexResult` rather than restated, so a field added there
   * (`skippedLanguages`, XSPEC-365 R2) reaches the CLI summary instead of being
   * silently dropped by a hand-maintained copy of the shape.
   */
  code: Omit<ProjectIndexResult, "parseHealth">;
  // Was an inline restatement of KnowledgeIndexResult's five fields — a second
  // copy that had to be edited in lockstep, and the reason `docsScanned` /
  // `docsUnresolved` were invisible here until the compiler said so. Reference
  // the type instead of repeating it.
  knowledge?: KnowledgeIndexResult;
  /** Present only when `--scip` was given. See {@link ingestScipOverlay}. */
  scip?: ScipIngestStats & { documentsInIndex: number; filesMatched: number };
  /**
   * Parse-health rollup (XSPEC-334 R1b/R1d): the coarse clean/partial/failed
   * counts derived from this run's per-file health, plus the healed/regressed
   * file lists vs. the previous manifest. The bulky per-file array itself is
   * NOT surfaced here — it lives in the on-disk manifest (see
   * `parse-manifest.ts`); this is the compact summary a CLI line / JSON
   * consumer wants. Present on every index run.
   */
  parseHealth?: ParseHealthSummary & { healed: string[]; regressed: string[] };
  /**
   * Directory symlinks under `<dir>` that were not walked (XSPEC-373 B3).
   * Absent when there were none. See `walk.ts`'s `WalkResult` for why these
   * are reported rather than followed.
   */
  skippedSymlinkDirs?: string[];
  /**
   * Linked git worktrees under `<dir>` that were not walked, and how many files lay in them.
   * Absent when there were none. A worktree is a second copy of a repository already being
   * indexed; walking it doubled every function name (see `walk.ts`'s `isLinkedWorktree`).
   */
  skippedWorktrees?: { paths: string[]; files: number };
  /** Files matched by extension but unreadable (XSPEC-373 B7). Absent when none. */
  unreadableFiles?: Array<{ path: string; reason: string }>;
  /**
   * Source-looking files this run saw but did not index because their
   * extension isn't covered by any supported language (XSPEC-414 R1) —
   * `.git`, `node_modules` and binary files are excluded, same as `code`'s
   * own walk. Unlike `skippedSymlinkDirs`/`unreadableFiles`, this field is
   * ALWAYS present (even when `count` is 0): it is a standing denominator
   * question ("how much of this tree did we not even try to index?"), not an
   * exceptional condition worth hiding on the happy path.
   */
  unindexedCode: UnindexedSummary;
  /**
   * What `--exclude` kept out of this run (XSPEC-457 R5). Present exactly when
   * patterns were given, including when nothing matched — a pattern that
   * matches nothing is the typo the summary must expose, not hide.
   *
   * `byPattern` (XSPEC-476 R3) says what each pattern matched on its own; the
   * totals above cannot tell which of several patterns did nothing.
   */
  excluded?: { patterns: string[]; paths: string[]; files: number; byPattern: ExcludedByPattern[] };
  /** Present exactly when `--incremental` was given (XSPEC-508 R6). */
  incremental?: IncrementalSummary;
  /**
   * Present when files of this root got a root-qualified id because another root of the graph
   * already holds their relative path (XSPEC-508 R6). Without it those files would have been
   * written onto the other root's nodes.
   */
  rootQualifiedIds?: { label: string; files: number; examples: Array<{ path: string; id: string }> };
  /**
   * Present when this root's section and another root's section hold the SAME graph id: a graph
   * an older egr built from roots that share a relative path, whose nodes are mixed. Nothing here
   * can separate them; the fix is a rebuild (XSPEC-508 R6, `code-graph/root-ids.ts`).
   */
  sharedNodes?: { count: number; examples: Array<{ id: string; otherRoot: string }> };
}

/**
 * What an `--incremental` run did (XSPEC-508 R6). `reparsed` is counted where the
 * parser is called, not inferred from the change list, so it is the evidence that
 * unchanged files were not parsed again.
 */
export interface IncrementalSummary {
  /** `full` when the remembered state could not be used; `reason` says why. */
  mode: "incremental" | "full";
  reason?: string;
  /** Files whose source was parsed in this run. */
  reparsed: number;
  /** Files taken from the remembered facts without parsing. */
  reused: number;
  /** Files that existed before and whose content (or language reading) changed. */
  changed: number;
  /** Files that were not in the graph before. */
  added: number;
  /** Files that were in the graph and are no longer indexed (deleted, renamed away, newly excluded). */
  removed: number;
  /** Graph writes the difference needed. `edgesRemoved` does not count edges that went with a removed node (DETACH DELETE). */
  nodesRemoved: number;
  edgesRemoved: number;
  edgesWritten: number;
  /** The `--changed-from` ref, when given. */
  changedFrom?: string;
}

/**
 * Read+parse a `.scip` (protobuf) index file, turning the low-level failure
 * modes a user can actually hit into a clear, actionable CLI error instead of
 * a bare filesystem/protobuf exception:
 *   - the path doesn't exist (typo, forgot to generate it, wrong cwd), or
 *   - the file exists but isn't a valid SCIP protobuf (wrong file entirely,
 *     truncated/corrupt, or a `.scip.gz`/other format `scip-dotnet`/`scip-java`
 *     didn't produce this way).
 *
 * Deliberately does NOT attempt to invoke `scip-dotnet`/`scip-java`/etc.
 * itself — egr only ever *reads* an already-generated `.scip` file; producing
 * one is the caller's own build toolchain's job (see docs).
 */
function readScipIndexOrThrow(path: string): ReturnType<typeof readScipIndex> {
  if (!existsSync(path)) {
    throw new Error(`--scip: file not found: ${path}`);
  }
  try {
    return readScipIndex(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `--scip: "${path}" could not be parsed as a SCIP protobuf index (${msg}). ` +
        `egr does not generate .scip files itself — produce one with an external SCIP indexer for the ` +
        `language in question (e.g. \`scip-dotnet index\` for C#, \`scip-java index\` for Java) and pass ` +
        `its output file here.`,
    );
  }
}

/**
 * Turn a Kuzu "Binder exception" naming a missing `provider`/`confidence`
 * column into a pointed, ACCURATE remediation message, regardless of which
 * write actually tripped it.
 *
 * **This should not fire in practice any more.** Every real `egr` invocation
 * opens its `GraphConnection` via `graph-db/open.ts`'s `openGraph`, which now
 * runs `schema-migration.ts`'s `migrateSchemaColumns` right after
 * `initSchema` on EVERY connection open — it detects exactly this gap (an
 * existing table missing a column `schema.ts` currently declares) and closes
 * it with a non-destructive `ALTER TABLE ... ADD IF NOT EXISTS` before any
 * command logic runs, backing up the on-disk DB file first. So by the time
 * `cmdIndex` below reaches this check, the CALLS table should already have
 * been migrated. This function remains as defense-in-depth for the one case
 * that bypasses that: a caller that constructs a bare `GraphConnection` +
 * `initSchema` directly instead of going through `openGraph` (some tests do
 * this deliberately, to exercise a pre-migration schema). For that case the
 * fix is simple and NON-destructive — no need to delete anything: call
 * `migrateSchemaColumns(conn)` (or just switch the caller to `openGraph`,
 * which does this automatically) — a full DB rebuild is only a last resort
 * now, not the primary remediation.
 */
function rethrowAsSchemaMigrationError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(
    `--scip: this graph's CALLS table predates the "provider"/"confidence" columns SCIP ingest needs ` +
      `(a pre-XSPEC-333-R3 schema). This connection was not opened through "openGraph" (graph-db/open.ts), ` +
      `which would have auto-migrated it — call "migrateSchemaColumns(conn)" (graph-db/schema-migration.ts) ` +
      `on this connection first; it non-destructively ALTERs the existing table to add the missing column(s) ` +
      `(backing up the DB file first) rather than requiring a full re-index. (underlying error: ${msg})`,
  );
}

function isMissingProvenanceColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /binder exception/i.test(msg) && /(provider|confidence)/i.test(msg);
}

/**
 * Pre-flight check, run BEFORE the tree-sitter pass whenever `--scip` is
 * requested: confirms the CALLS table actually has the `provider`/
 * `confidence` columns SCIP ingest's merge needs.
 *
 * As of `open.ts`'s `openGraph` auto-running `migrateSchemaColumns` on every
 * connection open, this gap should already be closed by the time `cmdIndex`
 * runs against any connection obtained the normal way — this check now only
 * catches connections that bypassed `openGraph` (see
 * `rethrowAsSchemaMigrationError`'s doc). Kept rather than removed: it's a
 * cheap read, and a clear message beats a raw Kuzu Binder exception even in
 * that narrower case.
 *
 * Why this can't just be a try/catch around the SCIP write alone (an earlier
 * version of this file did exactly that, and it was wrong): `cmdIndex` always
 * runs the tree-sitter `indexProject` pass FIRST, and tree-sitter's own
 * `buildCallEdges` (XSPEC-333 R3 OQ-4) ALSO unconditionally stamps
 * `provider`/`confidence` on every CALLS edge it writes — so on a pre-
 * migration graph, the tree-sitter pass hits the exact same Kuzu Binder
 * exception first, before the SCIP overlay's own writeFragment call is ever
 * reached (unless tree-sitter happens to resolve zero CALLS edges for this
 * project, which is not the common case). Wrapping only the SCIP write left
 * the friendly migration message practically unreachable for any real
 * project — the user would hit tree-sitter's own raw Binder exception
 * instead. Checking the schema up front, before either pass runs, makes the
 * friendly message fire regardless of which write would have tripped it.
 *
 * A zero-row `MATCH` still triggers Kuzu's binder-time column check (it's a
 * static schema check, not a runtime one), so this is safe to run against an
 * empty graph too.
 */
async function assertCallsSchemaHasProvenanceColumns(conn: GraphConnection): Promise<void> {
  try {
    await conn.query(`MATCH (:Function)-[r:CALLS]->(:Function) RETURN r.provider AS provider, r.confidence AS confidence LIMIT 1`);
  } catch (err) {
    if (isMissingProvenanceColumnError(err)) rethrowAsSchemaMigrationError(err);
    throw err;
  }
}

/**
 * `--scip <path>` overlay: read an externally-generated SCIP index, resolve
 * it against the SAME source files `egr index` just walked, and merge the
 * result on top of whatever `indexProject` already wrote (XSPEC-333 R3).
 *
 * ## Path basis
 *
 * A SCIP index's `Document.relativePath` is relative to whatever project
 * root the external indexer was invoked from (verified against real
 * `scip-dotnet`/`scip-java` output — see `test/fixtures/scip-*-poc/load-fixture.ts`),
 * and is ALWAYS `/`-separated per the SCIP protobuf schema's own documented
 * convention ("the path must use '/' as the separator, including on
 * Windows" — see `scip_pb.ts`). `egr index <dir>`'s own paths come from
 * `walkFiles`, which now normalizes to the same `/`-separated convention at
 * its own source point (`code-graph/path-utils.ts`'s `toPosixPath`, XSPEC-333
 * R3 follow-up) regardless of the host OS's separator — this function's
 * overlap check, and the id scheme `ingestScipIndex` derives from
 * `relativePath`, both do plain string equality against these two path sets,
 * and both sides are now guaranteed `/`-separated on every platform, not
 * just POSIX. (Previously this was a real, unfixed gap: a `\`-separated
 * `walkFiles` path would not string-match a `/`-separated SCIP document path
 * on Windows, so this overlay could silently match nothing even when `<dir>`
 * WAS the right root. Verified via string-level unit tests against
 * manufactured Windows-style path strings, not a real Windows host — see
 * `test/scip-windows-path-normalization.test.ts`; this sandbox has none to
 * test against. See `code-graph/path-utils.ts`'s module doc for why
 * normalizing ONLY inside `walkFiles` — this function's original fix —
 * turned out to be an incomplete "single source of truth" claim, caught by
 * adversarial review: `mcp/server.ts`'s `index_code`/`index_docs` tools are
 * a SECOND id-generating entry point that bypasses `walkFiles` entirely, so
 * `extractor.ts`'s `collectExtraction` — the actual common choke point for
 * every id, called by both entry points — now ALSO normalizes, independent
 * of this function's own `walkFiles`-sourced comparison.)
 *
 * A non-empty but suspiciously small overlap (e.g. 1 of 50 files matching by
 * name coincidence) is also not specially detected here beyond the
 * `definitionsResolved === 0 && callsEmitted === 0` warning `cli/index.ts`'s
 * human-readable formatter prints — there is no overlap-ratio threshold,
 * since a normal, correct run can legitimately have a low ratio (e.g. a
 * `.scip` index covering many more compiler-generated documents than
 * `walkFiles` ever walks).
 *
 * ## Schema compatibility
 *
 * See {@link assertCallsSchemaHasProvenanceColumns}, called by `cmdIndex`
 * before this function runs.
 */
export async function ingestScipOverlay(
  conn: GraphConnection,
  dir: string,
  scipPath: string,
  codeFiles: Array<{ path: string; source: string }>,
): Promise<NonNullable<IndexResultSummary["scip"]>> {
  const index = readScipIndexOrThrow(scipPath);
  if (index.documents.length === 0) {
    throw new Error(`--scip: "${scipPath}" parsed as a valid SCIP index but contains no documents — is it empty?`);
  }

  // Issue #3: SCIP mandates "/" in Document.relativePath "including on Windows", but scip-dotnet run on
  // Windows writes "\" anyway. walkFiles already normalizes our side (XSPEC-333 R3 follow-up); normalize
  // theirs too, on the index itself, because ingestScipIndex matches documents by this same field.
  for (const d of index.documents) d.relativePath = toPosixPath(d.relativePath);
  const docPaths = new Set(index.documents.map((d) => d.relativePath));
  const scipFiles: ScipSourceFile[] = codeFiles
    .filter((f) => docPaths.has(f.path))
    .map((f) => ({ relativePath: f.path, source: f.source }));

  if (scipFiles.length === 0) {
    const sample = index.documents[0]?.relativePath;
    throw new Error(
      `--scip: none of the ${docPaths.size} document path(s) in "${scipPath}" (e.g. "${sample}") matched ` +
        `any source file under "${dir}". SCIP document paths are relative to the project root the external ` +
        `indexer (scip-dotnet/scip-java/etc.) was run against — pass that same root as <dir>, then retry. ` +
        `(Path separators are already normalized on both sides, so a "\\" vs "/" difference is not the cause.)`,
    );
  }

  const { fragment, stats } = ingestScipIndex(index, scipFiles);
  try {
    await writeFragment(conn, fragment);
  } catch (err) {
    if (isMissingProvenanceColumnError(err)) rethrowAsSchemaMigrationError(err);
    throw err;
  }

  return { ...stats, documentsInIndex: docPaths.size, filesMatched: scipFiles.length };
}

/** Why a graph with nodes shared between roots cannot be updated in place, and what to do about it. */
function sharedNodesReason(a: IdAssignment): string {
  const e = a.shared[0]!;
  return (
    `${a.shared.length} node(s) of this root (e.g. ${e.id}) are also held by another root (${e.otherRoot}) of this graph: ` +
    `an older egr wrote one node for the same relative path of both roots, so what belongs to which cannot be told apart. ` +
    `Rebuild the graph once (egr index <dir> --clean, or index-all.sh --clean) and the roots get separate ids`
  );
}

/**
 * The code half of `egr index --incremental` (XSPEC-508 R6). See
 * `code-graph/incremental.ts` for the design; this decides full vs incremental,
 * runs it, and returns what `cmdIndex` needs to finish (manifest, state).
 */
async function indexCodeIncrementally(
  conn: GraphConnection,
  args: {
    dir: string;
    root: string;
    codeFiles: ProjectFile[];
    manifest: ReturnType<typeof readManifest>;
    manifestPath: string | undefined;
    clean: boolean;
    changedFrom: string | undefined;
    /** The graph ids assigned to `codeFiles` (`code-graph/root-ids.ts`). */
    assignment: IdAssignment;
  },
): Promise<{ extraction: DetailedProjectExtraction; summary: IncrementalSummary; token: string }> {
  const { dir, root, codeFiles, manifest, manifestPath, clean, changedFrom, assignment } = args;
  const token = newToken();
  const statePath = manifestPath ? statePathForManifest(manifestPath) : null;

  // 1. Can the remembered facts be used?
  let prev: RootState | undefined;
  let reason: string | undefined;
  if (!statePath) {
    reason = "no manifest path was given, so there is nowhere to keep the incremental state";
  } else if (clean) {
    reason = "--clean empties the graph, so everything is parsed again";
  } else if (assignment.shared.length > 0) {
    // Only a graph an older egr built can get here: new ids never meet another root's. Said first,
    // because it outlasts every other reason (a full index does not separate the nodes).
    reason = sharedNodesReason(assignment);
  } else {
    const found = inspectState(statePath);
    const usable = usableState({ root, manifest, state: found.state, stateProblem: found.problem, egrVersion: EGR_VERSION });
    if (usable.ok) {
      prev = usable.prev;
      const rows = await conn.query("MATCH (m:Module) RETURN count(m) AS c");
      if (Number(rows[0]?.c ?? 0) < Object.keys(prev.files).length) {
        reason = "the graph holds fewer files than the incremental state remembers (it was emptied or replaced)";
        prev = undefined;
      }
    } else {
      reason = usable.reason;
    }
  }

  // 2. Full: index everything and start the state from it.
  if (!prev) {
    const extraction = extractProjectDetailed(codeFiles, { hash: true });
    await writeFragment(conn, extraction.fragment);
    return {
      extraction,
      token,
      summary: {
        mode: "full",
        reason: reason!,
        reparsed: extraction.parsed,
        reused: 0,
        changed: 0,
        added: extraction.parsed,
        removed: 0,
        nodesRemoved: 0,
        edgesRemoved: 0,
        edgesWritten: 0,
        ...(changedFrom !== undefined ? { changedFrom } : {}),
      },
    };
  }

  // 3. Incremental: parse what changed, reuse the rest.
  const remembered = prev.files;
  const trusted = changedFrom !== undefined ? gitChangedPaths(dir, changedFrom) : null;
  const extraction = extractProjectDetailed(codeFiles, {
    reuse: (file, language, hash) => {
      const path = toPosixPath(file.path);
      const old = remembered[path];
      if (!old || old.language !== language) return undefined;
      // The id is part of every remembered node; a file whose id is now another one is parsed again.
      if (moduleIdOf(old) !== toPosixPath(file.id ?? file.path)) return undefined;
      // `--changed-from`: git is the authority on what changed; a file it does not list is not even hashed.
      if (trusted && !trusted.has(path)) return old;
      return old.hash === hash() ? old : undefined;
    },
  });
  const nowPaths = new Set(extraction.facts.map((f) => f.path));
  const removedPaths = Object.keys(remembered).filter((p) => !nowPaths.has(p));
  const addedPaths = [...extraction.freshPaths].filter((p) => !(p in remembered));

  // The state describes the graph as of the last run; from here on the graph is being edited, so it
  // must not survive a crash (see the module doc of code-graph/incremental.ts).
  if (statePath) dropRootState(statePath, root);
  const delta = await applyDelta(conn, Object.values(remembered), extraction.facts, extraction.fragment.nodes);

  return {
    extraction,
    token,
    summary: {
      mode: "incremental",
      reparsed: extraction.parsed,
      reused: extraction.reused,
      changed: extraction.parsed - addedPaths.length,
      added: addedPaths.length,
      removed: removedPaths.length,
      ...delta,
      ...(changedFrom !== undefined ? { changedFrom } : {}),
    },
  };
}

/**
 * The Markdown documents `egr index <dir> --docs` feeds the knowledge parser, in the shape it takes.
 * One function for `index --docs` and `lint`, so the two cannot disagree about which files are documents.
 *
 * `source` (XSPEC-481 R4): the absolute path, so a later run over another directory can tell
 * that the id it is about to overwrite was written from a different file. `fallbackId` stays
 * relative — it names the document for id resolution and for the R2 conflict lines.
 */
export function collectKnowledgeDocs(
  dir: string,
  exclude?: ExcludeMatcher,
): { docs: KnowledgeDoc[]; files: Array<{ path: string; source: string }> } {
  const root = resolve(dir);
  const files = walkFiles(dir, [".md"], { exclude }).files;
  return {
    files,
    docs: files.map((f) => ({ content: f.source, fallbackId: f.path, source: canonicalFilePath(join(root, f.path)) })),
  };
}

/**
 * `egr lint <dir> [--exclude <glob>]...` — replacement-relation consistency of the documents under `<dir>`
 * (DEC-140). Reads the documents the way `index --docs` does; never opens the graph, never writes, no model.
 */
export async function cmdLint(opts: { dir: string; exclude?: string[] }): Promise<LintReport> {
  const st = statSync(opts.dir, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new Error(`lint: ${opts.dir} is not a directory`);
  const exclude = opts.exclude?.length ? compileExcludes(opts.exclude) : undefined;
  return lintKnowledgeDocs(collectKnowledgeDocs(opts.dir, exclude).docs);
}

/**
 * `egr index <dir> [--docs] [--clean] [--scip <path>]` — index code (always)
 * + knowledge docs (--docs) + an external SCIP index overlay (--scip).
 *
 * `--scip` always runs AFTER the tree-sitter pass above, but this ordering is
 * not load-bearing: `writeFragment`'s provenance-aware merge policy is
 * confidence-based, not arrival-order-based, so re-running either pass in
 * either order converges to the same graph (see `graph-db/writer.ts`'s
 * `shouldOverwrite` and `test/scip-merge.test.ts`'s "cross-provider upgrade"
 * case). This command still assumes NEITHER pass has to have run before —
 * a single `egr index <dir> --scip <path>` call is a complete, from-scratch
 * index (tree-sitter baseline + SCIP overlay in one shot); it does not require
 * a prior plain `egr index <dir>` run.
 *
 * When `opts.scip` is given, the CALLS-schema check runs BEFORE the
 * tree-sitter pass, not just around the SCIP write — see
 * {@link assertCallsSchemaHasProvenanceColumns}'s doc for why the schema
 * gap is actually hit by tree-sitter's own write first on a real project,
 * not only by SCIP's.
 */
export async function cmdIndex(
  conn: GraphConnection,
  opts: {
    dir: string;
    docs?: boolean;
    clean?: boolean;
    scip?: string;
    manifestPath?: string;
    exclude?: string[];
    /** Parse only the files that changed since the last `--incremental` index (XSPEC-508 R6). */
    incremental?: boolean;
    /** With `incremental`: take the list of changed files from `git diff <ref>` instead of hashing every file. */
    changedFrom?: string;
  },
): Promise<IndexResultSummary> {
  if (opts.changedFrom !== undefined && !opts.incremental) {
    throw new Error("--changed-from only makes sense with --incremental");
  }
  if (opts.incremental && opts.scip) {
    throw new Error(
      "--incremental cannot be combined with --scip: the SCIP overlay is written for the whole index, and an incremental run would not know which of its edges to keep. Run the SCIP overlay with a plain `egr index`.",
    );
  }
  if (opts.clean) await clearGraph(conn); // drop existing data so deleted nodes are pruned
  if (opts.scip) await assertCallsSchemaHasProvenanceColumns(conn);
  // `detectShebangScripts: true` (XSPEC-414 R4 OQ2) only on the CODE walk —
  // see `walkFiles`' doc comment for why the docs walk below must NOT opt in.
  // `--exclude` applies to BOTH walks — the documents the user complained about
  // were counted by the docs walk below, not this one.
  const exclude = opts.exclude?.length ? compileExcludes(opts.exclude) : undefined;
  const codeWalk = walkFiles(opts.dir, CODE_EXTS, { detectShebangScripts: true, exclude });
  const codeFiles = codeWalk.files;

  // Read the PREVIOUS manifest before this run rewrites this dir's section, so
  // R1d can diff which files healed/regressed. Keyed by ABSOLUTE index root so
  // a shared DB indexed from several dirs (dev-platform's index-all.sh) diffs
  // each dir only against its own prior section — see parse-manifest.ts's
  // module doc for why a flat file list would break here. Null on a first
  // index / when no manifest path is supplied (e.g. a bare-connection test).
  const prevManifest = opts.manifestPath ? readManifest(opts.manifestPath) : null;
  const root = resolve(opts.dir);
  const prevRun = prevManifest?.runs[root] ?? null;
  // Which graph id each file gets (XSPEC-508 R6, code-graph/root-ids.ts): its relative path, as ever,
  // unless another root of this graph holds that path - then a root-qualified one. Decided against the
  // manifest as the graph stands, i.e. none on --clean, which empties the graph first.
  const assignment = assignIds({
    root,
    manifest: opts.clean ? null : prevManifest,
    relPaths: codeFiles.map((f) => toPosixPath(f.path)),
  });
  const idFiles: ProjectFile[] = codeFiles.map((f) => {
    const rel = toPosixPath(f.path);
    const id = assignment.ids.get(rel)!;
    return id === rel ? f : { ...f, id };
  });
  if (opts.scip && assignment.qualified > 0) {
    // The SCIP overlay builds its node ids from the plain relative path; for these files that is
    // ANOTHER root's node. Refuse before anything is written rather than attach edges to it.
    throw new Error(
      `--scip cannot be combined with this root: ${assignment.qualified} of its files share a relative path with another root of the graph ` +
        `and carry root-qualified ids, which the SCIP overlay does not produce. Index this root into a graph of its own to use --scip.`,
    );
  }
  // `--clean` drops the WHOLE graph (clearGraph above), then rebuilds only this
  // dir — so the manifest must likewise drop every OTHER root's section, else
  // indexHealth (R2) would keep counting/warning about files from roots that
  // are no longer in the graph (zombie sections). Rebuild the manifest from
  // scratch on clean (this root's prevRun is still kept for the healed diff).
  const upsertBase = opts.clean ? null : prevManifest;

  // `parseHealth` (the bulky per-file array) is split off here: it feeds the
  // on-disk manifest, while `code` (the 7 numeric counts) is what the compact
  // summary surfaces — keeping the per-file array out of `--json` output.
  let parseHealth: Awaited<ReturnType<typeof indexProject>>["parseHealth"];
  let code: Omit<ProjectIndexResult, "parseHealth">;
  let incremental: { summary: IncrementalSummary; facts: DetailedProjectExtraction["facts"]; token: string } | undefined;
  if (opts.incremental) {
    const r = await indexCodeIncrementally(conn, {
      dir: opts.dir,
      root,
      codeFiles: idFiles,
      manifest: prevManifest,
      manifestPath: opts.manifestPath,
      clean: opts.clean === true,
      changedFrom: opts.changedFrom,
      assignment,
    });
    ({ parseHealth, ...code } = r.extraction);
    incremental = { summary: r.summary, facts: r.extraction.facts, token: r.token };
  } else {
    ({ parseHealth, ...code } = await indexProject(conn, idFiles));
  }
  // Seen-but-not-indexed accounting (XSPEC-414 R1). Derived from the SAME
  // walk `codeFiles` came from, so "code.files" and "unindexedCode.count"
  // describe the same tree, not two walks that could disagree.
  const result: IndexResultSummary = { code, unindexedCode: summarizeUnindexed(codeWalk.unindexed) };
  if (incremental) result.incremental = incremental.summary;
  if (assignment.qualified > 0 && assignment.rootLabel) {
    result.rootQualifiedIds = {
      label: assignment.rootLabel,
      files: assignment.qualified,
      examples: [...assignment.ids].filter(([rel, id]) => rel !== id).slice(0, 3).map(([path, id]) => ({ path, id })),
    };
  }
  if (assignment.shared.length > 0) {
    result.sharedNodes = { count: assignment.shared.length, examples: assignment.shared.slice(0, 3) };
  }
  // Directory symlinks are neither descended into nor, previously, recorded
  // (XSPEC-373 B3). Surfaced from the code walk, which covers the whole tree;
  // the docs walk below re-walks the same directories and would only repeat it.
  if (codeWalk.skippedSymlinkDirs.length > 0) result.skippedSymlinkDirs = codeWalk.skippedSymlinkDirs;
  // Linked git worktrees are not walked either; the docs walk skips the same directories, so the
  // code walk's account is the whole one.
  if (codeWalk.skippedWorktrees.paths.length > 0) result.skippedWorktrees = codeWalk.skippedWorktrees;
  if (codeWalk.unreadable.length > 0) result.unreadableFiles = codeWalk.unreadable;
  // The code walk sees every non-skipped file in an excluded subtree, so its
  // count is the whole one; the docs walk's would only repeat it.
  if (exclude && codeWalk.excluded) {
    result.excluded = {
      patterns: [...exclude.patterns],
      paths: codeWalk.excluded.paths,
      files: codeWalk.excluded.files,
      // A pattern that matched nothing and looks like Git Bash's path conversion made it gets the reason (XSPEC-481 R5).
      byPattern: codeWalk.excluded.byPattern.map((b) => {
        const hint = b.nothingMatched ? msysPathConversionHint(b.pattern) : "";
        return hint ? { ...b, hint } : b;
      }),
    };
  }
  if (opts.docs) {
    const { docs, files: docFiles } = collectKnowledgeDocs(opts.dir, exclude);
    result.knowledge = await indexKnowledgeDocs(conn, docs);
    // XSPEC-457 R7: the code walk saw every `.md` as "not covered by any
    // supported language", and with `--docs` the same files went into the graph
    // a moment later — so the summary said a document was indexed and, on the
    // next line, that it was not. A file the docs pass took in is not unindexed;
    // without `--docs` nothing took it in and it stays listed. Paths are
    // relative to the same root in both walks.
    const taken = new Set(docFiles.map((f) => f.path));
    result.unindexedCode = summarizeUnindexed(codeWalk.unindexed.filter((u) => !taken.has(u.path)));
  }
  if (opts.scip) {
    result.scip = await ingestScipOverlay(conn, opts.dir, opts.scip, codeFiles);
  }

  // Parse-health manifest (XSPEC-334 R1b/R1d): replace ONLY this root's section
  // (preserving other roots), and diff against this root's previous section.
  // A manifest-write failure (disk full / read-only dir) is surfaced on stderr
  // but does NOT fail the index — the graph is already written, and observability
  // failing must not undo a successful index (same spirit as R1a's per-file
  // tolerance). The summary/diff are still computed when no manifestPath is
  // given, so programmatic/test callers get the counts without a file.
  const nextManifest = upsertRun(upsertBase, root, new Date().toISOString(), parseHealth, EGR_VERSION, opts.exclude, incremental?.token, assignment.rootLabel);
  if (opts.manifestPath) {
    try {
      writeManifest(opts.manifestPath, nextManifest);
      // The state is written LAST and only once the manifest carrying its token is on disk: a state
      // without a matching manifest section is never used (see usableState).
      if (incremental) {
        const statePath = statePathForManifest(opts.manifestPath);
        const state: IncrementalState = readState(statePath) ?? { version: STATE_VERSION, roots: {} };
        const section: RootState = {
          token: incremental.token,
          ...fingerprint(EGR_VERSION),
          files: Object.fromEntries(incremental.facts.map((f) => [f.path, f])),
        };
        // `--clean` empties the whole graph, so no other root's remembered facts describe it any more.
        state.roots = opts.clean ? { [root]: section } : { ...state.roots, [root]: section };
        writeState(statePath, state);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[egr] warning: parse-health manifest not written (${msg}); the index itself succeeded\n`);
    }
  }
  const { healed, regressed } = diffRuns(prevRun?.files ?? null, parseHealth);
  result.parseHealth = { ...summarize(parseHealth), healed, regressed };

  return result;
}

/**
 * Ask a symbol question only after the graph has confirmed it knows the symbol
 * (XSPEC-457 R4).
 *
 * `callers(X)` and `callees(X)` both return `[]` for "X is in the graph and has
 * none" and for "X is not in the graph" — and the CLI printed `(none)` and
 * exited 0 for both, so a mistyped name read as "nothing calls it, safe to
 * delete". Unknown symbols now throw {@link NotInGraphError}, which the CLI
 * turns into a non-zero exit, like `top BogusLabel`. A known symbol with no
 * callers still prints `(none)` and exits 0.
 */
async function knownSymbol<T>(conn: GraphConnection, symbol: string, ask: () => Promise<T>): Promise<T> {
  await requireFunction(conn, symbol);
  return ask();
}

/**
 * What `egr callers` / `egr callees` answer: the nodes and the definitions they
 * were made from (XSPEC-514 R1). A name reused by several functions is answered,
 * and the answer says so — `scope.mergedDefinitions` and `scope.definitions`.
 */
export interface CallQueryAnswer extends DefinitionScope {
  symbol: string;
  rows: CallNode[];
}

async function callQuery(
  conn: GraphConnection,
  symbol: string,
  depth: number,
  file: string | undefined,
  ask: (stored: string | undefined) => Promise<CallNode[]>,
): Promise<CallQueryAnswer> {
  await requireFunction(conn, symbol);
  // A --file that names none of the definitions throws here (exit 1): it is a
  // question about a definition that is not there, not an empty list of callers.
  const scope = await definitionScope(conn, symbol, file);
  return { symbol, ...scope, rows: await ask(scope.file) };
}

/** `egr callers <symbol> [--depth N] [--file <path>]`, with the definitions the answer combines. */
export function cmdCallersAnswer(conn: GraphConnection, symbol: string, depth = 1, file?: string): Promise<CallQueryAnswer> {
  return callQuery(conn, symbol, depth, file, (stored) => callers(conn, symbol, depth, stored));
}

/** `egr callees <symbol> [--depth N] [--file <path>]`, with the definitions the answer combines. */
export function cmdCalleesAnswer(conn: GraphConnection, symbol: string, depth = 1, file?: string): Promise<CallQueryAnswer> {
  return callQuery(conn, symbol, depth, file, (stored) => callees(conn, symbol, depth, stored));
}

/** The caller rows of {@link cmdCallersAnswer}. */
export async function cmdCallers(conn: GraphConnection, symbol: string, depth = 1, file?: string): Promise<CallNode[]> {
  return (await cmdCallersAnswer(conn, symbol, depth, file)).rows;
}

/** The callee rows of {@link cmdCalleesAnswer}. */
export async function cmdCallees(conn: GraphConnection, symbol: string, depth = 1, file?: string): Promise<CallNode[]> {
  return (await cmdCalleesAnswer(conn, symbol, depth, file)).rows;
}

/**
 * `egr implementers <spec-id>` — files (+ functions) that implement a spec.
 * A spec id the graph has never seen throws (it used to print a message and
 * exit 0; XSPEC-457 R2/R4). A spec that exists with no implementers does not.
 */
export async function cmdImplementers(conn: GraphConnection, specId: string): Promise<ImplementersResult> {
  const result = await implementers(conn, specId);
  if (result.origin === null) throw new NotInGraphError("spec", specId, await suggestSpecs(conn, specId));
  return result;
}

/**
 * `egr implemented-by <module-path>` — specs a file declares it implements.
 * A path that matches no module, or several, throws; a module that is indexed
 * and declares nothing does not.
 */
export async function cmdImplementedSpecs(conn: GraphConnection, moduleId: string): Promise<ImplementedSpecsResult> {
  const result = await implementedSpecs(conn, moduleId);
  if (result.ambiguousMatches?.length) {
    throw new Error(
      `"${moduleId}" is ambiguous — ${result.ambiguousMatches.length} modules end with this path:\n` +
        result.ambiguousMatches.map((m) => `  ${m}`).join("\n") +
        `\nGive more of the path.`,
    );
  }
  if (!result.moduleFound) throw new NotInGraphError("module", moduleId, await suggestModules(conn, moduleId));
  return result;
}

/** `egr impact <spec-id> [--max-hops N]`. A spec id the graph has never seen throws. */
export async function cmdImpact(conn: GraphConnection, nodeId: string, maxHops = 3) {
  await requireSpec(conn, nodeId);
  return impactAnalysis(conn, nodeId, maxHops);
}

/** `egr feedback <type> <node-id> [--label L]`. A node that is not there throws (it used to print and exit 0). */
export async function cmdFeedback(
  conn: GraphConnection,
  type: string,
  nodeId: string,
  label: ConfidenceLabel = "Function",
  weight?: number,
) {
  const mapped = feedbackForEventType(type);
  const update = await applyFeedback(
    conn,
    { nodeId, signal: mapped.signal, weight: weight ?? mapped.weight, source: "cli" },
    label,
  );
  if (!update) throw new NotInGraphError("node", nodeId, [], label);
  return update;
}

/** `egr top <label> [--limit N]`. */
export function cmdTop(conn: GraphConnection, label: ConfidenceLabel, limit = 10) {
  return topByConfidence(conn, label, limit);
}

/** `egr god-nodes [--limit N]` — highest-importance nodes across code + knowledge (DEC-027 L3). */
export function cmdGodNodes(conn: GraphConnection, limit = 10): Promise<GodNode[]> {
  return godNodes(conn, limit);
}

/** `egr communities` — Function-call clusters via Louvain (DEC-027 L3). */
export function cmdCommunities(conn: GraphConnection): Promise<CommunityMember[]> {
  return communities(conn);
}

/**
 * `egr communities --limit N` (XSPEC-476 R5b): keep the N LARGEST communities —
 * every member of each, never half of one — largest first, ties to the smaller
 * community id; the rows keep the order `communities` gave them.
 *
 * It counts communities, not rows: a cut through the middle of a community
 * would show a cluster that is not the cluster. Without `--limit` the answer is
 * unchanged (all of them), which on a real project is megabytes of JSON.
 */
export function limitCommunities<T extends { communityId: number }>(rows: readonly T[], limit: number): T[] {
  const sizes = new Map<number, number>();
  for (const m of rows) sizes.set(m.communityId, (sizes.get(m.communityId) ?? 0) + 1);
  const keep = new Set(
    [...sizes.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([id]) => id),
  );
  return rows.filter((m) => keep.has(m.communityId));
}

/** How many distinct communities `rows` hold — for saying "showing N of M". */
export function countCommunities(rows: ReadonlyArray<{ communityId: number }>): number {
  return new Set(rows.map((r) => r.communityId)).size;
}

/**
 * `communityId` the engine gives a function that has no `CALLS` edge at all
 * (XSPEC-481 R2). It is the absence of a community, not a community: on a real
 * project it was 1,813 functions that "formed" the largest group, which then came
 * first under every `--limit`.
 */
export const UNCLUSTERED_COMMUNITY_ID = -1;

/** What `egr communities` reports (XSPEC-481 R2): the real communities, and the unclustered functions counted apart. */
export interface CommunitiesReport {
  /** One row per member, as before. Functions with no CALLS edge (`communityId` -1) are in it only when asked for. */
  communities: CommunityMember[];
  /** Real communities in the graph — the unclustered functions are not one. */
  communityCount: number;
  /** Real communities among `communities` (fewer than `communityCount` when `--limit` cut). */
  shownCommunities: number;
  /** Functions with no CALLS edge: how many there are, and whether `communities` lists them. */
  unclustered: { count: number; listed: boolean };
}

/**
 * Turn the engine's answer into the report `egr communities` prints
 * (XSPEC-481 R2): the unclustered functions leave the community count and the
 * `--limit` count, and are listed only with `includeUnclustered`. Their number is
 * always reported, so that "not listed" is never mistaken for "none".
 */
export function shapeCommunities(
  all: readonly CommunityMember[],
  opts: { limit?: number; includeUnclustered?: boolean } = {},
): CommunitiesReport {
  const real = all.filter((m) => m.communityId !== UNCLUSTERED_COMMUNITY_ID);
  const lonely = all.filter((m) => m.communityId === UNCLUSTERED_COMMUNITY_ID);
  const kept = opts.limit !== undefined ? limitCommunities(real, opts.limit) : [...real];
  return {
    communities: opts.includeUnclustered ? [...lonely, ...kept] : kept,
    communityCount: countCommunities(real),
    shownCommunities: countCommunities(kept),
    unclustered: { count: lonely.length, listed: opts.includeUnclustered === true },
  };
}

/** `egr related <node-id> [--depth N] [--limit N]` — seed-anchored ranking (DEC-028 L4a). */
export async function cmdRelated(conn: GraphConnection, seedId: string, depth = 2, limit = 10): Promise<RelatedNode[]> {
  const rows = await related(conn, seedId, depth, limit);
  // `related` answers [] for both "no such seed" and "a seed with nothing around
  // it"; only the second is an answer (XSPEC-457 R4). The seed's own node is
  // inside its neighbourhood, so an unknown id is the only way to get here empty
  // before the ranking runs.
  if (rows.length === 0) await requireNode(conn, seedId);
  return rows;
}

/** One blindspot file (a file that parsed partially or failed). */
export interface Blindspot {
  path: string;
  language: string;
  /** Top-most ERROR/MISSING nodes; 0 when the file threw (see `failed`). */
  errorNodes: number;
  /** True when parsing threw entirely (the file contributed nothing). */
  failed: boolean;
}

export interface BlindspotsResult {
  filesIndexed: number;
  partial: number;
  failed: number;
  /** Every unhealthy file, worst-first (failed before partial, then by errorNodes desc). */
  blindspots: Blindspot[];
}

/** One parse-failure signature bucket (XSPEC-334 R3a). */
export interface SignatureBucket {
  signature: string;
  language: string;
  /** How many files hit this exact failure shape. */
  fileCount: number;
  /** A few example files (capped) — the full list is in the manifest. */
  sampleFiles: string[];
}

/**
 * Hard parse failures grouped by what went wrong, rather than by structural
 * signature — a file that threw never produced a tree to fingerprint.
 */
export interface FailureBucket {
  /** Normalised error text: the shared shape, with paths and numbers removed. */
  reason: string;
  /** The languages this failure hit, so "all C#" is visible at a glance. */
  languages: string[];
  fileCount: number;
  sampleFiles: string[];
}

export interface SignaturesResult {
  /** Files that carry ≥1 signature (i.e. partial parses; failed files have none). */
  filesWithSignatures: number;
  /** Buckets, most-files-first — a single grammar gap collapses many files here. */
  buckets: SignatureBucket[];
  /**
   * Files that failed outright, grouped by normalised error message.
   *
   * These used to be invisible here. Signatures are computed from a parse
   * tree, and a file that threw has no tree, so hard failures carried none —
   * the command reported only partial parses. There was a fallback message for
   * them, but it fired only when there were *no* partial signatures at all, so
   * a single partial file was enough to hide any number of failures behind it.
   * A user indexing a C# repository saw "2 distinct failure types across 2
   * partial-parse files" while 584 .cs files had failed to parse entirely.
   *
   * Grouping matters most for exactly this case: 584 files sharing one cause
   * should read as one problem, not as 584 lines in `egr blindspots`.
   */
  failureBuckets: FailureBucket[];
  /** Files that failed outright (the sum over `failureBuckets`). */
  filesFailed: number;
}

/**
 * Reduce an error message to the part that is common across files hitting the
 * same cause: drop absolute/relative paths, quoted fragments and numbers, so
 * 584 messages differing only by filename collapse to one bucket.
 *
 * Deliberately crude. Over-merging two distinct causes costs a reader one
 * extra look at `egr blindspots`; under-merging reproduces the wall of
 * near-identical lines this exists to replace.
 */
export function normaliseFailureReason(message: string): string {
  return message
    // Windows and POSIX paths, including the bare filenames that follow them.
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
    .replace(/(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+/g, "<path>")
    // Anything quoted — usually a symbol or file that varies per occurrence.
    .replace(/'[^']*'/g, "'<x>'")
    .replace(/"[^"]*"/g, '"<x>"')
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const SIGNATURE_SAMPLE_LIMIT = 5;

/**
 * `egr signatures` (XSPEC-334 R3a) — group the manifest's partial-parse files
 * by failure signature, so one grammar gap that broke many files shows as ONE
 * bucket ("N files, same shape") instead of N scattered blindspots. A VIEW
 * over the manifest (R1b); the signatures themselves are structural node-type
 * fingerprints, never source text (see `error-signature.ts`).
 */
export function cmdSignatures(manifestPath: string): SignaturesResult {
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    return { filesWithSignatures: 0, buckets: [], failureBuckets: [], filesFailed: 0 };
  }
  const bySig = new Map<string, { language: string; files: string[] }>();
  const byFailure = new Map<string, { languages: Set<string>; files: string[] }>();
  let filesWithSignatures = 0;
  let filesFailed = 0;
  for (const f of allFiles(manifest)) {
    if (f.failed !== undefined) {
      // A file that threw has no tree and therefore no structural signature.
      // Group it by what it threw instead, so a single shared cause reads as
      // one bucket rather than disappearing.
      filesFailed += 1;
      const reason = normaliseFailureReason(f.failed);
      let entry = byFailure.get(reason);
      if (!entry) {
        entry = { languages: new Set(), files: [] };
        byFailure.set(reason, entry);
      }
      entry.languages.add(f.language);
      entry.files.push(f.path);
      continue;
    }
    if (!f.signatures || f.signatures.length === 0) continue;
    filesWithSignatures += 1;
    for (const sig of f.signatures) {
      let entry = bySig.get(sig);
      if (!entry) {
        entry = { language: f.language, files: [] };
        bySig.set(sig, entry);
      }
      entry.files.push(f.path);
    }
  }
  const failureBuckets: FailureBucket[] = [...byFailure.entries()]
    .map(([reason, e]) => ({
      reason,
      languages: [...e.languages].sort(),
      fileCount: e.files.length,
      sampleFiles: e.files.slice(0, SIGNATURE_SAMPLE_LIMIT),
    }))
    .sort((a, b) => b.fileCount - a.fileCount || a.reason.localeCompare(b.reason));
  const buckets: SignatureBucket[] = [...bySig.entries()]
    .map(([signature, e]) => ({
      signature,
      language: e.language,
      fileCount: e.files.length,
      sampleFiles: e.files.slice(0, SIGNATURE_SAMPLE_LIMIT),
    }))
    .sort((a, b) => b.fileCount - a.fileCount || a.signature.localeCompare(b.signature));
  return { filesWithSignatures, buckets, failureBuckets, filesFailed };
}

/**
 * `egr blindspots` (XSPEC-334 R2b) — a VIEW over the parse-health manifest
 * (R1b), listing every file that parsed partially or failed. The manifest is
 * the single source of truth; this is not a second store. Returns empty when
 * no manifest exists (nothing indexed yet with a manifest-writing egr).
 */
export function cmdBlindspots(manifestPath: string): BlindspotsResult {
  const manifest = readManifest(manifestPath);
  if (!manifest) return { filesIndexed: 0, partial: 0, failed: 0, blindspots: [] };
  const files = allFiles(manifest);
  const unhealthy = files.filter((f) => !isHealthy(f));
  let partial = 0;
  let failed = 0;
  for (const f of unhealthy) (f.failed !== undefined ? failed++ : partial++);
  const blindspots: Blindspot[] = unhealthy
    .map((f) => ({ path: f.id ?? f.path, language: f.language, errorNodes: f.errorNodes, failed: f.failed !== undefined }))
    .sort((a, b) => Number(b.failed) - Number(a.failed) || b.errorNodes - a.errorNodes || a.path.localeCompare(b.path));
  return { filesIndexed: files.length, partial, failed, blindspots };
}

export interface GcResult {
  /** The branch-graph dir inspected, or null when not a git repo. */
  dir: string | null;
  /** Orphan graph files (branches that no longer exist). */
  orphans: string[];
  /** True when orphans were actually removed (i.e. not a dry run). */
  deleted: boolean;
}

/**
 * `egr gc [--dry-run]` — remove per-branch graphs whose branch no longer
 * exists. Inspects `<git-common-dir>/engram/`; a `<name>.db` is an
 * orphan when no current local branch sanitizes to `<name>`. Also clears the
 * sibling `<name>.db.wal` left by Kuzu.
 */
export function cmdGc(opts: { cwd?: string; dryRun?: boolean }): GcResult {
  const cwd = opts.cwd ?? process.cwd();
  const dir = gitBranchEngramDir(cwd);
  if (!dir || !existsSync(dir)) return { dir, orphans: [], deleted: false };

  const valid = new Set(listBranches(cwd).map((b) => `${sanitizeBranch(b)}.db`));
  const orphans = readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .filter((f) => !valid.has(f));

  if (!opts.dryRun) {
    for (const f of orphans) {
      rmSync(join(dir, f), { recursive: true, force: true });
      rmSync(join(dir, `${f}.wal`), { recursive: true, force: true });
      // Also remove the per-branch parse-health manifest sibling (XSPEC-334
      // R1b) — a new sibling file class gc must learn to clean, else it leaks
      // one `<branch>.parse-manifest.json` per deleted branch forever.
      rmSync(join(dir, manifestPathForDb(f)), { force: true });
    }
  }
  return { dir, orphans, deleted: !opts.dryRun && orphans.length > 0 };
}

/**
 * `egr doctor` — what this installation can actually do on this machine.
 *
 * **Why this exists, and why it is not an install-time message.** The original
 * design put this information in `preinstall`/`postinstall` hooks. It does not
 * reach anyone: npm suppresses lifecycle-script output by default, and npm ≥ 11
 * additionally blocks those scripts behind an approval gate — measured on
 * 2026-08-04 by running the real user command (`npm install -g engramgraph`,
 * no `--foreground-scripts`) and finding zero occurrences of either notice in
 * 242 lines of output. Every test of those hooks had passed, because every
 * test invoked them the way they were written rather than the way users
 * install.
 *
 * A command the user types cannot be suppressed by a package manager. That is
 * the whole argument for moving it here.
 */
export interface DoctorLanguage {
  language: SupportedLanguage;
  label: string;
  package: string;
  available: boolean;
  /** Why it is unavailable; absent when it loaded fine. */
  reason?: string;
  /** True when this platform has no prebuilt binary and must compile it. */
  compilesFromSource: boolean;
}

export interface DoctorResult {
  egrVersion: string;
  node: string;
  platform: string;
  graphDb: string;
  languages: DoctorLanguage[];
  available: number;
  unavailable: number;
  /** Native dependencies with no prebuilt binary for this platform. */
  compiledFromSource: Array<{ package: string; kind: string; languages: string[] }>;
  /**
   * Commands that will need network access on THIS machine; everything else
   * works offline. Empty when the ALGO extension is already local (XSPEC-457 R3).
   * Meaningful only when `networkStatus` is "needed" — see there.
   */
  networkCommands: string[];
  /**
   * `none`: nothing here reaches the network. `needed`: `networkCommands` will
   * download on first use. `undetermined`: cannot be told from this machine
   * (the commands are still listed in `networkCommands` as the ones affected).
   */
  networkStatus: "none" | "needed" | "undetermined";
  /** Where the ALGO extension (god-nodes, communities, related) comes from on this machine. */
  algo: AlgoSource;
}

export function cmdDoctor(dbPath: string, algoDeps?: Parameters<typeof describeAlgoSource>[0]): DoctorResult {
  const unavailable = new Map(
    unavailableGrammars().map((g) => [g.language, g]),
  );
  const fromSource = compiledFromSourceOn();
  const fromSourcePackages = new Set(fromSource.map((d) => d.package));

  const languages: DoctorLanguage[] = GRAMMARS.map((g) => {
    const failure = unavailable.get(g.language);
    return {
      language: g.language,
      label: g.label,
      package: g.package,
      available: failure === undefined,
      ...(failure ? { reason: failure.reason } : {}),
      compilesFromSource: fromSourcePackages.has(g.package),
    };
  });

  // Read the same resolver the three commands use, instead of restating a list
  // (XSPEC-457 R3): the list said "needs network" on machines where it never did.
  const algo = describeAlgoSource(algoDeps);
  const local = algo.source === "bundled-package" || algo.source === "user-cache";

  return {
    egrVersion: EGR_VERSION,
    node: process.version,
    platform: currentPlatform(),
    graphDb: dbPath,
    languages,
    available: languages.filter((l) => l.available).length,
    unavailable: languages.filter((l) => !l.available).length,
    compiledFromSource: fromSource.map((d) => ({
      package: d.package,
      kind: d.kind,
      languages: d.languages,
    })),
    networkCommands: local ? [] : [...ALGO_BACKED_COMMAND_LIST],
    networkStatus: local ? "none" : algo.source === "download" ? "needed" : "undetermined",
    algo,
  };
}

/**
 * `egr refs check <path...>` (DEC-115 L2). Thin wrapper over
 * {@link checkRefs} kept here for the same reason every other `cmd*`
 * function is: unit-testable in isolation from arg parsing, and so it can
 * sit in `read-only-command-list.test.ts`'s hand-written command map
 * alongside the other read-only commands.
 */
export async function cmdRefsCheck(conn: GraphConnection, paths: string[]): Promise<RefCheckResult> {
  return checkRefs(conn, paths);
}
