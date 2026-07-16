/**
 * Parse-health manifest: the on-disk SSOT for a graph's index health
 * (XSPEC-334 R1b/R1d).
 *
 * `egr index` writes one manifest per graph, as a sibling of the graph DB
 * (`.engram/graph.db` → `.engram/graph.parse-manifest.json`). It is a **run
 * artifact**: it carries its own `indexedAt` timestamps + a version
 * fingerprint, and it is never mutated except by a full re-index of a section.
 * Reading it back is always "the health of the last index of each root".
 *
 * ## Why sections keyed by index root (adversarial-review must-fix)
 *
 * A single graph DB is frequently built by SEVERAL `egr index <dir>` calls
 * into ONE DB — dev-platform's `index-all.sh` indexes 7 different sub-repo
 * dirs into `.engram/graph.db`. A flat single `files` list would be
 * *overwritten* to only the LAST dir's files on every run, so (a) R2's
 * `indexHealth` SSOT would cover ~1/7 of the graph, and (b) R1d's healing diff
 * would compare one repo's files against a different repo's — healed/regressed
 * would be permanently wrong/empty, and repos with colliding relative paths
 * (`vibeops/src/index.ts` vs `EngramGraph/src/index.ts` both walk to
 * `index.ts`) would fabricate cross-repo transitions. So the manifest is
 * keyed by **absolute index root**: each `egr index <dir>` replaces only
 * `runs[resolve(dir)]` and diffs only against that same root's previous
 * section. `allFiles` unions every section for a whole-graph view (R2).
 *
 * NOTE (documented caveat, not fixed here): the union CAN still contain two
 * entries with the same relative `path` from two different roots (the same
 * collision the shared graph itself already has on Module ids). R1 only
 * guarantees the *diff* never conflates them; disambiguating the union is R2's
 * concern when it maps a query result back to a health record.
 *
 * ## Version fingerprint (drives R1c staleness)
 *
 * `egrVersion` + `grammarVersions` fingerprint the *parser*. A tree-sitter
 * grammar upgraded via `npm update` leaves every source file's mtime
 * untouched, so an mtime-only staleness check never re-indexes after a grammar
 * bump that might fix — or regress — real files. Recording the fingerprint
 * lets a staleness check (R1c's `--if-stale`) treat "same source, newer
 * parser" as stale. This is the root-cause fix for "failed files retry after a
 * grammar upgrade" — NOT a separate failed-file retry queue.
 */

import { createRequire } from "node:module";
import { renameSync, readFileSync, writeFileSync, rmSync } from "node:fs";

import type { FileParseHealth } from "./parse-health.js";

/**
 * The tree-sitter grammar packages whose resolved versions fingerprint the
 * parser. Kept 1:1 with `extractor.ts`'s grammar imports (the core
 * `tree-sitter` runtime is included — its ABI/version affects every parse).
 * A version that can't be read (e.g. a package that blocks `/package.json` in
 * its `exports`) is simply omitted rather than failing the index — the
 * fingerprint degrades gracefully to whatever IS readable plus `egrVersion`.
 */
const GRAMMAR_PACKAGES = [
  "tree-sitter",
  "tree-sitter-javascript",
  "tree-sitter-typescript",
  "tree-sitter-c-sharp",
  "tree-sitter-python",
  "tree-sitter-go",
  "tree-sitter-java",
  "@tree-sitter-grammars/tree-sitter-kotlin",
  "tree-sitter-rust",
  "tree-sitter-cpp",
  "tree-sitter-ruby",
  "tree-sitter-php",
  "@vokturz/tree-sitter-dart",
] as const;

const require = createRequire(import.meta.url);
let grammarVersionsCache: Record<string, string> | null = null;

/**
 * Resolved versions of the bundled tree-sitter grammar packages, memoized
 * (they can't change within a process). Reads each package's `package.json`
 * `version`; a package whose version can't be read is omitted (see
 * `GRAMMAR_PACKAGES` doc).
 */
export function grammarVersions(): Record<string, string> {
  if (grammarVersionsCache) return grammarVersionsCache;
  const out: Record<string, string> = {};
  for (const name of GRAMMAR_PACKAGES) {
    try {
      const pkg = require(`${name}/package.json`) as { version?: string };
      if (typeof pkg.version === "string") out[name] = pkg.version;
    } catch {
      // omit — fingerprint degrades gracefully (see GRAMMAR_PACKAGES doc)
    }
  }
  grammarVersionsCache = out;
  return out;
}

/** Coarse clean/partial/failed rollup — a derived VIEW, not a persisted taxonomy. */
export interface ParseHealthSummary {
  total: number;
  /** Parsed with no error nodes and no throw. */
  clean: number;
  /** Parsed but with ≥1 error node (partial parse — some regions unmatched). */
  partial: number;
  /** `collectExtraction` threw; the file contributed nothing (R1a). */
  failed: number;
}

/**
 * A file is "healthy" when it parsed with no thrown error and no error nodes.
 *
 * Deliberately a *parse-success* predicate, NOT a *produced-output* one: a
 * file that parses cleanly but whose tag query yields zero definitions
 * (`functions === 0` on a non-empty source — the OTHER half of "silently
 * missing nodes") is still `healthy` here. Folding zero-yield into "unhealthy"
 * was considered and rejected — far too many legitimate files have no
 * function/class definitions (pure-constant modules, re-export barrels,
 * interface-only `.ts`), so it would swamp the signal with false positives.
 * The zero-yield signal is still RAW-recorded per file (`functions`/`classes`)
 * for future analysis; it just isn't a health gate. See XSPEC-334 R1b.
 */
export function isHealthy(f: FileParseHealth): boolean {
  return f.failed === undefined && f.errorNodes === 0;
}

/** Derive the coarse clean/partial/failed view from raw per-file records. */
export function summarize(files: FileParseHealth[]): ParseHealthSummary {
  let clean = 0;
  let partial = 0;
  let failed = 0;
  for (const f of files) {
    if (f.failed !== undefined) failed += 1;
    else if (f.errorNodes > 0) partial += 1;
    else clean += 1;
  }
  return { total: files.length, clean, partial, failed };
}

/** One index root's section of a manifest (see `ParseManifest.runs`). */
export interface ManifestRun {
  /** ISO timestamp of the `egr index <dir>` run that wrote this section. */
  indexedAt: string;
  /** Per-file raw measurements for the files under this root (R1b). */
  files: FileParseHealth[];
}

/** The persisted manifest shape. */
export interface ParseManifest {
  /** egr package version that produced this manifest. */
  egrVersion: string;
  /** Resolved tree-sitter grammar package versions (staleness fingerprint). */
  grammarVersions: Record<string, string>;
  /** Per-index-root sections, keyed by absolute root — see module doc. */
  runs: Record<string, ManifestRun>;
}

/** `<...>/<name>.db` → `<...>/<name>.parse-manifest.json` (R1b sibling file). */
export function manifestPathForDb(dbPath: string): string {
  return dbPath.replace(/\.db$/, "") + ".parse-manifest.json";
}

/**
 * Return a new manifest with `runs[root]` replaced by this run's section
 * (every OTHER root's section preserved), and the parser fingerprint refreshed.
 * `prev` is the manifest read before this run (null on a first index).
 */
export function upsertRun(
  prev: ParseManifest | null,
  root: string,
  indexedAt: string,
  files: FileParseHealth[],
  egrVersion: string,
): ParseManifest {
  const runs = { ...(prev?.runs ?? {}) };
  runs[root] = { indexedAt, files };
  return { egrVersion, grammarVersions: grammarVersions(), runs };
}

/** Every file across every root's section — the whole-graph view (R2 SSOT). */
export function allFiles(manifest: ParseManifest): FileParseHealth[] {
  // Defensive `?? {}`: a manifest from an older egr / hand-edited file may lack
  // `runs`; `readManifest` already rejects those, but a bare `Object.values`
  // on `undefined` would throw and take a *query* down with it (R2 reads this
  // on every query) — the same "observability must not break the real op"
  // rule cmdIndex follows for manifest writes.
  return Object.values(manifest.runs ?? {}).flatMap((r) => r.files ?? []);
}

/**
 * Read a manifest, or `null` if absent/unreadable/malformed (a first index has
 * none). Validates the shape (`runs` must be an object) so a syntactically
 * valid but structurally wrong JSON — `{}`, `[]`, a pre-`runs` manifest — is
 * treated as "no manifest" rather than crashing a downstream `allFiles`.
 */
export function readManifest(path: string): ParseManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { runs?: unknown }).runs !== "object" ||
      (parsed as { runs?: unknown }).runs === null
    ) {
      return null;
    }
    return parsed as ParseManifest;
  } catch {
    return null;
  }
}

/**
 * Atomically write a manifest (temp file + rename, so a reader never sees a
 * partial write). The temp name includes the pid so two processes indexing the
 * same graph don't clobber each other's temp file. On failure the temp file is
 * removed and the error rethrown — the caller (cmdIndex) decides whether a
 * manifest-write failure should surface (it does NOT abort a successful index).
 */
export function writeManifest(path: string, manifest: ParseManifest): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Files that went unhealthy→healthy (healed) or healthy→unhealthy (regressed) between indexes. */
export interface HealingDiff {
  /** Files unhealthy in `prev`, healthy in `next`. */
  healed: string[];
  /** Files healthy in `prev`, unhealthy in `next` — a true regression. */
  regressed: string[];
}

/**
 * Diff one root's previous file list against this run's (R1d). `healed`/
 * `regressed` are true *transitions* only: a brand-new file absent from `prev`
 * is NOT a regression even if it parses partially (it was never healthy to
 * regress from — it shows up in the summary's `partial`/`failed` counts
 * instead). A partial↔failed change is invisible here (both are unhealthy),
 * which is intended — the summary counts still move. Returns empty lists when
 * `prevFiles` is null (first index of this root).
 */
export function diffRuns(prevFiles: FileParseHealth[] | null, nextFiles: FileParseHealth[]): HealingDiff {
  const healed: string[] = [];
  const regressed: string[] = [];
  if (!prevFiles) return { healed, regressed };

  const prevByPath = new Map(prevFiles.map((f) => [f.path, f]));
  for (const cur of nextFiles) {
    const before = prevByPath.get(cur.path);
    if (!before) continue; // new file — not a transition
    const wasHealthy = isHealthy(before);
    const nowHealthy = isHealthy(cur);
    if (!wasHealthy && nowHealthy) healed.push(cur.path);
    else if (wasHealthy && !nowHealthy) regressed.push(cur.path);
  }
  return { healed, regressed };
}
