// SPDX-License-Identifier: MIT
/**
 * Which indexed files are newer than the index.
 *
 * A graph is a snapshot. Between the moment a file is edited and the moment `egr index` runs again (by hand, or
 * `egr watch` after its debounce), every answer built from that file describes the old one — and an answer does not
 * say so. This turns that into a number on `indexHealth` (`staleFiles`), so `explore`, `call_chain` and the CLI can
 * say "the index is behind by N file(s)" instead of staying silent.
 *
 * ## What is compared
 *
 * For every index root recorded in the parse-health manifest, each file it lists is `stat`ed under that root:
 * newer than the moment the run that wrote the section began (`startedAt`, else `indexedAt`) is stale — it was changed
 * after, or while, it was read. A file that is gone while its root is still there is stale too: the graph still
 * holds it. Time, not content: a file touched without a change is counted (the next incremental run, which compares
 * hashes, finds nothing to do and the count goes back to 0).
 *
 * ## What it cannot see (stated, not hidden)
 *
 * - **A file created after the index** is not in the manifest, so it is not counted. Finding it would take a walk of
 *   the whole tree on every query; `egr watch` is what picks it up.
 * - **Markdown** is not in the parse-health manifest, so a changed document is not counted either.
 * - A root that is not on this machine (the manifest came from another one), and the MCP `index_code` record
 *   ({@link MCP_INDEX_ROOT}, which has no directory), are skipped, never counted as stale.
 * - Clock and file-system time resolution: a file written in the very millisecond the run began is not counted.
 *
 * ## Cost
 *
 * One `stat` per indexed file. A long-running MCP server asks on every query, so the answer for one manifest is
 * reused for {@link STALE_SCAN_TTL_MS}; a re-index rewrites the manifest, which is a new object and is scanned again.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { MCP_INDEX_ROOT, type ParseManifest } from "./parse-manifest.js";

/** How long one manifest's scan is reused. Short on purpose: it is a hint about "now". */
export const STALE_SCAN_TTL_MS = 1_000;
const MAX_SAMPLE = 20;

export interface StaleScan {
  /** Number of indexed files that are newer than the index, or gone. */
  count: number;
  /** Up to 20 of them, as graph ids (the path the graph and the query results use). */
  sample: string[];
}

const cache = new WeakMap<ParseManifest, { at: number; epoch: number; scan: StaleScan }>();
let epoch = 0;

/** Forget remembered scans (tests; a scan is otherwise reused for {@link STALE_SCAN_TTL_MS}). */
export function clearStaleScanCache(): void {
  epoch += 1;
}

function scanOnce(manifest: ParseManifest): StaleScan {
  let count = 0;
  const sample: string[] = [];
  for (const [root, run] of Object.entries(manifest.runs ?? {})) {
    if (root === MCP_INDEX_ROOT) continue;
    const since = Date.parse(run.startedAt ?? run.indexedAt);
    if (!Number.isFinite(since)) continue;
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue; // the root is not here (another machine's manifest): nothing to compare with
    }
    for (const f of run.files ?? []) {
      let stale = false;
      try {
        stale = statSync(join(root, f.path)).mtimeMs > since;
      } catch (err) {
        // Gone is stale; any other failure to look (permissions) is "cannot tell", which is not stale.
        stale = (err as NodeJS.ErrnoException).code === "ENOENT";
      }
      if (!stale) continue;
      count += 1;
      if (sample.length < MAX_SAMPLE) sample.push(f.id ?? f.path);
    }
  }
  return { count, sample };
}

/** The files of `manifest` that are newer than the index (see the module doc). */
export function scanStaleFiles(manifest: ParseManifest, now: number = Date.now()): StaleScan {
  const hit = cache.get(manifest);
  if (hit && hit.epoch === epoch && now - hit.at < STALE_SCAN_TTL_MS) return hit.scan;
  const scan = scanOnce(manifest);
  cache.set(manifest, { at: now, epoch, scan });
  return scan;
}
