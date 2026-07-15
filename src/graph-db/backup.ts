/**
 * Pre-migration DB file backup.
 *
 * Pure filesystem helper (no Kuzu dependency) so it is unit-testable without a
 * live connection. Used by `schema-migration.ts` to snapshot the on-disk graph
 * DB file immediately before an `ALTER TABLE ... ADD` runs against it, so a
 * schema migration can never be the sole copy of a user's accumulated data
 * (notably SAGE confidence adjustments on Function/Class/Spec/Decision/Doc
 * nodes — see `sage/writer.ts` — which a from-scratch rebuild would zero out).
 *
 * Verified empirically (see `alter-table-experiment.mjs`-style probe against
 * ryugraph@25.9.1): this project's pinned Kuzu fork stores a graph DB as a
 * single regular file at the configured path (no sidecar directory), plus an
 * ephemeral `<path>.wal` that exists only between a write and the next clean
 * close/checkpoint. `fs.cpSync` is used (not `copyFileSync`) so this still
 * does the right thing if a future Kuzu version switches to directory-based
 * storage (`cpSync` recurses into directories; `copyFileSync` would throw).
 */

import { cpSync, existsSync } from "node:fs";

/** Maximum numbered suffixes to try before giving up (defensive bound). */
const MAX_SUFFIX_ATTEMPTS = 1000;

/**
 * Copy `dbPath` (and its `.wal` sidecar, if present) to a sibling backup path
 * that never overwrites an existing backup — repeated migration events (e.g.
 * a project that picks up two separate schema changes over its lifetime)
 * each get their own numbered backup.
 *
 * @returns the backup path actually used, or `null` if `dbPath` does not
 *   exist yet (nothing to protect — e.g. a brand-new DB whose CREATE TABLE
 *   is about to run for the very first time; callers should not call this in
 *   that case, but returning `null` instead of throwing keeps this function
 *   safe to call defensively).
 */
export function backupDbFile(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;

  const base = `${dbPath}.pre-migration-backup`;
  let target = base;
  for (let n = 2; existsSync(target); n += 1) {
    if (n > MAX_SUFFIX_ATTEMPTS) {
      throw new Error(
        `backupDbFile: could not find a free backup filename after ${MAX_SUFFIX_ATTEMPTS} attempts under "${base}-N" — refusing to overwrite an existing backup.`,
      );
    }
    target = `${base}-${n}`;
  }

  cpSync(dbPath, target, { recursive: true, errorOnExist: true });

  const walPath = `${dbPath}.wal`;
  if (existsSync(walPath)) {
    cpSync(walPath, `${target}.wal`, { recursive: true, errorOnExist: true });
  }

  return target;
}
