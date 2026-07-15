/**
 * Pre-migration DB file backup.
 *
 * Pure filesystem helper (no Kuzu dependency) so it is unit-testable without a
 * live connection. Used by `schema-migration.ts` to snapshot the on-disk graph
 * DB file immediately before an `ALTER TABLE ... ADD` runs against it, so a
 * schema migration can never be the sole copy of a user's accumulated data —
 * concretely, `Function.confidence` (SAGE's feedback-adjusted score, see
 * `sage/writer.ts`), which a from-scratch rebuild would reset to its `1.0`
 * default. (An adversarial review flagged that this protection is real but
 * narrower than it might sound: it protects the value AT THE MOMENT of
 * migration — it does NOT change the separate, pre-existing fact that a
 * subsequent plain `egr index` re-index resets `Function.confidence` back to
 * `1` regardless of migration, since `writer.ts`'s `shouldOverwrite` always
 * allows a same-provider rewrite — see `schema-migration.ts`'s module doc for
 * the full accounting. This backup is still a strict improvement over the old
 * "delete the whole DB" remediation, which destroyed that value immediately
 * and unconditionally, not just on the next re-index.)
 *
 * Callers should issue Kuzu's `CHECKPOINT` statement on their live connection
 * immediately before calling this (see `schema-migration.ts`), so the on-disk
 * file this copies is fully flushed and self-consistent rather than
 * potentially depending on WAL entries not yet merged into it.
 *
 * Verified empirically against this project's pinned `ryugraph@25.9.1`
 * (a Kuzu-derived embedded engine): a graph DB is a single regular file at
 * the configured path (no sidecar directory), plus an ephemeral `<path>.wal`
 * that exists only between a write and the next `CHECKPOINT`/clean close.
 * `fs.cpSync` is used (not `copyFileSync`) so this still does the right thing
 * if a future version switches to directory-based storage (`cpSync` recurses
 * into directories; `copyFileSync` would throw).
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

  // `errorOnExist` only has an effect when `force: false` (Node's default for
  // `force` is `true`, i.e. silently overwrite) — verified against Node's own
  // docs after an adversarial review caught an earlier version of this
  // function passing `errorOnExist: true` WITHOUT `force: false`, which was
  // dead code: `force`'s default of `true` meant a raced collision (another
  // process/call creating `target` between the `existsSync` loop above and
  // this `cpSync` call) would have silently clobbered it instead of erroring.
  // `force: false` closes that TOCTOU window: Node itself now refuses to
  // overwrite `target` if it exists, on top of the `existsSync` pre-check.
  cpSync(dbPath, target, { recursive: true, force: false, errorOnExist: true });

  const walPath = `${dbPath}.wal`;
  if (existsSync(walPath)) {
    cpSync(walPath, `${target}.wal`, { recursive: true, force: false, errorOnExist: true });
  }

  return target;
}
