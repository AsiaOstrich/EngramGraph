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

import {
  closeSync,
  cpSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";

/** Maximum numbered suffixes to try before giving up (defensive bound). */
const MAX_SUFFIX_ATTEMPTS = 1000;

/** Copy buffer size. Bounded so a large graph is not read into memory at once. */
const COPY_CHUNK_BYTES = 1024 * 1024;

/**
 * Copy one file in a way that tolerates the source being open elsewhere.
 *
 * **Why not `cpSync`/`copyFileSync` here.** Those go through Windows'
 * `CopyFileEx`, which opens the source without `FILE_SHARE_READ`. This backup
 * runs while the graph database is still open — the caller checkpoints a live
 * connection immediately before calling — so on Windows the copy hit its own
 * process's handle and failed:
 *
 *   EBUSY: resource busy or locked, copyfile
 *     '...\.engram\graph.db' -> '...\.engram\graph.db.pre-migration-backup'
 *
 * Reported by a user upgrading 0.7.0 → 0.8.0 on Windows 11, whose only way
 * forward was to move the database aside and rebuild — that is, to discard
 * exactly the accumulated data this backup exists to protect. POSIX `copyfile`
 * has no such restriction, which is why it was never seen on Linux or macOS.
 *
 * `openSync` goes through libuv's `CreateFileW`, which passes
 * `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, so reading a file
 * another handle holds open is allowed. The copy is chunked rather than
 * `readFileSync`-then-`writeFileSync` so a large graph is not materialised in
 * memory.
 *
 * The `wx` flag preserves this module's never-overwrite guarantee: the write
 * fails if the destination already exists, the same protection `cpSync`'s
 * `force: false` + `errorOnExist: true` provided.
 *
 * **Verification status.** The behaviour being fixed is Windows-specific and
 * has not been reproduced on this project's development machines — the
 * evidence is the user's report plus the documented `CopyFileEx` sharing
 * semantics. What IS verified here is that this function produces a
 * byte-identical copy, refuses to overwrite, and succeeds while the source is
 * held open (see `test/backup.test.ts`); on POSIX that last property holds
 * either way, so it is the Windows run of that test that carries the proof.
 */
function copyFileAllowingOpenSource(src: string, dest: string): void {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  const fdIn = openSync(src, "r");
  try {
    const fdOut = openSync(dest, "wx");
    try {
      let position = 0;
      for (;;) {
        const bytes = readSync(fdIn, buffer, 0, COPY_CHUNK_BYTES, position);
        if (bytes === 0) break;
        writeSync(fdOut, buffer, 0, bytes);
        position += bytes;
      }
    } finally {
      closeSync(fdOut);
    }
  } finally {
    closeSync(fdIn);
  }
}

/**
 * Copy a database path, whether it is a single file (today) or a directory
 * (if a future engine version switches to directory-based storage).
 *
 * Directories keep going through `cpSync` — a directory is not held open the
 * way the database file is, so the sharing problem does not arise, and
 * re-implementing recursive copy here would be strictly worse.
 */
function copyDbPath(src: string, dest: string): void {
  if (statSync(src).isDirectory()) {
    cpSync(src, dest, { recursive: true, force: false, errorOnExist: true });
    return;
  }
  copyFileAllowingOpenSource(src, dest);
}

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

  // The never-overwrite guarantee survives the switch away from `cpSync`: the
  // file path opens the destination with `wx`, which fails if it exists, and
  // the directory path still passes `force: false` + `errorOnExist: true`.
  // Either way Node itself refuses to clobber `target`, closing the TOCTOU
  // window between the `existsSync` loop above and the write below — a gap an
  // adversarial review previously caught being left open by `errorOnExist`
  // without `force: false` (Node's `force` defaults to `true`, i.e. silently
  // overwrite, so `errorOnExist` alone was dead code).
  copyDbPath(dbPath, target);

  const walPath = `${dbPath}.wal`;
  if (existsSync(walPath)) {
    copyDbPath(walPath, `${target}.wal`);
  }

  return target;
}
