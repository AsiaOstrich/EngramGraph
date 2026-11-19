/**
 * Query-side index health (XSPEC-334 R2).
 *
 * The graph's parse manifest (R1b) records which files parsed partially or
 * failed. R2 surfaces that to the *querier* — the party who otherwise gets a
 * silently-incomplete answer (an AI agent told "nothing calls foo, safe to
 * delete" when the one caller lived in a file that fell out of the graph). It
 * reads the manifest and, for a given query's result files, returns a compact
 * `IndexHealth`.
 *
 * ## Deliberately coarse, and honest about it (R2 / brainstorm)
 *
 * True *answer-scoped* completeness ("would this exact query have returned
 * more if file X had parsed?") is not computable: to know whether a blindspot
 * file contains a caller of `foo`, you would have to parse it — and it is a
 * blindspot precisely because it did not parse. So `possiblyIncomplete` is a
 * COARSE directory-subtree overlap: it fires when the result touches a
 * directory that also contains blindspot files. It is not a precise claim, and
 * it is non-constant (a query touching only fully-parsed subtrees gets no
 * flag) to avoid the warning fatigue that would train an agent to ignore it.
 *
 * ## No new field on a healthy graph (zero noise)
 *
 * `computeIndexHealth` returns `null` when the graph has NO unhealthy files, so
 * a fully-parsed graph's query responses are byte-identical to before R2 — the
 * signal only appears when there is something to signal.
 *
 * ## Known limitations (both structural, honestly stated)
 *
 * 1. **Cross-root path collision (structural, not occasional).** The manifest's
 *    file paths are the same *relative* paths the graph uses as Module ids. On
 *    a multi-root shared graph (dev-platform indexes 7 repos into one DB),
 *    common dir names (`cli/`, `mcp/`, `utils/`, `test/`) collide across repos
 *    as a matter of course — so a blindspot in vibeops's `cli/` can flag an
 *    EngramGraph result under `cli/`. This is NOT fixable here: the blindspot's
 *    root IS known (the `runs` key), but a query *result* file comes from the
 *    graph, where the Module id already conflated the two repos' same-relative
 *    paths and carries no root — there is nothing to match roots against
 *    without per-Module root tracking (a graph schema change, out of R2 scope).
 *    It is a direct consequence of the graph's own conflation, surfaced (not
 *    introduced) by R2. Global counts are unaffected; only `possiblyIncomplete`
 *    can over-fire.
 * 2. **Top-level blindspot under-fires (deliberate noise tradeoff).** The
 *    parent→child subtree rule holds at every level EXCEPT the repo root:
 *    `sameSubtree("", x)` is false, so a failed repo-root entry point
 *    (`index.ts` — often the highest-connectivity file) does NOT flag nested
 *    queries. Treating `""` as an ancestor would (correctly) match everything
 *    and fire on every query whenever any root-level file fails — pure noise.
 *    The cost of the chosen tradeoff: the most-connected failing file gets the
 *    weakest coverage. Accepted; documented rather than hidden.
 */

import { statSync, existsSync } from "node:fs";

import { allFiles, isHealthy, readManifest, type ParseManifest } from "./parse-manifest.js";
import { scanStaleFiles, type StaleScan } from "./stale-files.js";

/** Compact index-health surfaced on a query response (present only when there is something to say: blindspots, or files newer than the index). */
export interface IndexHealth {
  /** Total files across the graph's parse manifest. */
  filesIndexed: number;
  /** Files that parsed partially (≥1 error node) — some regions unmatched. */
  partial: number;
  /** Files that failed to parse entirely (threw). */
  failed: number;
  /**
   * True when this query's result files share a directory subtree with
   * blindspot (partial/failed) files — a coarse "the answer may be missing
   * nodes from unparsed files nearby" signal. Absent when the result touches
   * no blindspot subtree (or no result files were provided).
   */
  possiblyIncomplete?: boolean;
  /**
   * Set when the health signal itself could not be produced — a manifest that
   * exists but could not be read or parsed (XSPEC-373 B8). The counts above
   * are meaningless in that case; the point is that a consumer can distinguish
   * "no blindspots" from "we do not know whether there are blindspots", which
   * previously rendered as the same empty string.
   */
  unavailable?: string;
  /**
   * The blindspot files in the touched subtrees, capped at 20. Present iff
   * possiblyIncomplete. See `blindspotsTotal` for the true count — this list
   * may be truncated, so never infer the count from its length.
   */
  blindspots?: string[];
  /**
   * The FULL number of blindspot files in the touched subtrees (≥
   * `blindspots.length`). Present iff possiblyIncomplete; a consumer should
   * report this, not `blindspots.length`, so a truncated list never understates
   * how many files are affected.
   */
  blindspotsTotal?: number;
  /**
   * How many indexed files are newer than the index, or gone from disk — the answer may describe their old content
   * (see `stale-files.ts` for what is compared and what is not seen). Present only when it is at least 1, so a graph
   * that is up to date and parsed cleanly still carries no `indexHealth` at all. The cure is `egr index <dir>
   * --incremental`, or `egr watch <dir>` to have it done on every change. Not scoped to the answer: it counts the
   * whole graph.
   */
  staleFiles?: number;
  /** Up to 20 of those files, as graph ids. Present iff `staleFiles`. The count is the number to report. */
  staleSample?: string[];
}

/** Directory part of a `/`-separated path (`""` for a top-level file). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** True when one directory is the same as, or nested under, the other. */
function sameSubtree(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "" || b === "") return false; // a top-level file only matches top-level
  return a.startsWith(b + "/") || b.startsWith(a + "/");
}

const MAX_BLINDSPOTS_LISTED = 20;

/**
 * Compute {@link IndexHealth} from a manifest + the files a query's result
 * touched. Returns `null` when there is nothing to report (no manifest, or the
 * graph has zero unhealthy files) so callers attach nothing on a healthy graph.
 */
export function computeIndexHealth(manifest: ParseManifest | null, resultFiles: string[], stale?: StaleScan): IndexHealth | null {
  if (!manifest) return null;
  const files = allFiles(manifest);
  const unhealthy = files.filter((f) => !isHealthy(f));
  const staleCount = stale?.count ?? 0;
  if (unhealthy.length === 0 && staleCount === 0) return null; // healthy, current graph → no field, no noise

  let partial = 0;
  let failed = 0;
  for (const f of unhealthy) (f.failed !== undefined ? failed++ : partial++);
  const health: IndexHealth = { filesIndexed: files.length, partial, failed };

  if (unhealthy.length > 0 && resultFiles.length > 0) {
    const resultDirs = [...new Set(resultFiles.map(dirOf))];
    // In graph-id space, like the result files: a root-qualified file (`id`) is found under the
    // directory its Module id names, not under the bare relative path another root also has.
    const touched = unhealthy.filter((u) => resultDirs.some((rd) => sameSubtree(dirOf(u.id ?? u.path), rd)));
    if (touched.length > 0) {
      health.possiblyIncomplete = true;
      health.blindspotsTotal = touched.length; // full count — blindspots[] may be truncated
      health.blindspots = touched.slice(0, MAX_BLINDSPOTS_LISTED).map((u) => u.id ?? u.path);
    }
  }
  if (stale && staleCount > 0) {
    health.staleFiles = staleCount;
    health.staleSample = stale.sample;
  }
  return health;
}

/**
 * Per-path manifest cache keyed by mtime — a long-running MCP server reads the
 * manifest on EVERY query, and re-parsing a large (multi-thousand-file)
 * manifest each time is wasteful. Invalidates automatically when the file's
 * mtime changes (a re-index rewrites it), so freshness is preserved.
 */
const manifestCache = new Map<string, { mtimeMs: number; manifest: ParseManifest | null }>();

function readManifestCached(manifestPath: string): ParseManifest | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(manifestPath).mtimeMs;
  } catch {
    manifestCache.delete(manifestPath); // gone → drop any stale cache entry
    return null;
  }
  const cached = manifestCache.get(manifestPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.manifest;
  const manifest = readManifest(manifestPath);
  manifestCache.set(manifestPath, { mtimeMs, manifest });
  return manifest;
}

/**
 * Convenience: read the manifest at `manifestPath` (if any) and compute health
 * for `resultFiles`. Wrapped so that ANY failure here returns rather than
 * propagating — a broken health signal must never take down the query it is
 * annotating (the query already succeeded).
 *
 * ## "Healthy" and "we could not tell" are no longer the same answer
 *
 * This used to return `null` for three unrelated situations — no manifest
 * path, an unreadable/corrupt manifest, and a perfectly healthy graph — and
 * `healthNote` renders `null` as the empty string. So a corrupted manifest
 * produced output byte-for-byte identical to a clean bill of health
 * (XSPEC-373 B8). The mechanism built to reveal incomplete results was itself
 * unable to say that it had failed.
 *
 * A read failure now returns a health object carrying `unavailable`, so the
 * caller can say "unknown" instead of implying "fine". A missing path still
 * returns null: that is not a failure, it is a caller that never asked.
 */
export function readIndexHealth(manifestPath: string | undefined, resultFiles: string[]): IndexHealth | null {
  if (!manifestPath) return null;
  const unknown = (reason: string): IndexHealth => ({
    filesIndexed: 0,
    partial: 0,
    failed: 0,
    unavailable: reason,
  });
  try {
    const manifest = readManifestCached(manifestPath);
    // TWO layers of catch produced the same null: `readManifest` swallows a
    // parse error, and `readManifestCached` swallows a stat failure. Absent and
    // corrupt were therefore indistinguishable here — and one of them is
    // normal (nothing indexed yet) while the other means the health signal is
    // lying by omission. Existence separates them.
    if (manifest === null && existsSync(manifestPath)) {
      return unknown("manifest exists but could not be parsed");
    }
    // The disk is looked at here, not in `computeIndexHealth` (which stays a pure function of the manifest): a manifest
    // is a record of the last index, and "is anything newer than it" is a question to the files.
    return computeIndexHealth(manifest, resultFiles, manifest ? scanStaleFiles(manifest) : undefined);
  } catch (err) {
    return unknown(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The one line that says the graph is behind its files, for text output (the CLI's query notes and `explore`).
 * Says how many, names a few, and what to run. Empty when nothing is behind.
 */
export function staleNote(h: IndexHealth): string {
  if (!h.staleFiles) return "";
  const names = h.staleSample && h.staleSample.length > 0 ? ` (${h.staleSample.slice(0, 3).join(", ")}${h.staleFiles > 3 ? ", …" : ""})` : "";
  return (
    `⚠ index is behind: ${h.staleFiles} file(s) changed since this graph was indexed${names} — this answer may not reflect them; ` +
    `run \`egr index <dir> --incremental\`, or keep \`egr watch <dir>\` running`
  );
}
