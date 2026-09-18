import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What actually ends up in the published tarball. // implements XSPEC-365 AC-11
 *
 * The install hooks and the language registry are useless if they are not
 * shipped, and `package.json`'s `files` field being correct is not evidence
 * that they were: a typo, a `.npmignore`, or a path that only resolves in the
 * working tree all produce a `files` list that reads perfectly while the
 * tarball goes out without the file. From inside the repo those two situations
 * are indistinguishable — every local test passes either way, because locally
 * the file is right there.
 *
 * So this asks npm what it would actually pack, rather than asking the config
 * what it intends to.
 */

const ROOT = join(__dirname, "..");

/**
 * Snapshotted at module load — BEFORE `packedFiles()` runs anywhere below
 * (it is invoked at the top of the first `describe()` block's body, which
 * Vitest executes during collection, itself after this line runs). See the
 * guard test's own doc comment for what this is defending against.
 */
const DIST_CLI_INDEX = join(ROOT, "dist", "cli", "index.js");
const distCliIndexBefore = statSync(DIST_CLI_INDEX);

/**
 * The paths inside the tarball npm would publish, with the leading `package/`
 * stripped.
 *
 * **Why this builds a real tarball instead of reading `npm pack --json`.** The
 * JSON route was tried twice and broke twice, each time in an environment it
 * had not been run in before: once under `npm test` (the outer npm exports
 * `npm_config_*`, and the inherited value beat the `--ignore-scripts` flag, so
 * `prepare` ran and printed build progress onto stdout), and once in CI, where
 * trailing output after the JSON array defeated a "find the array and slice"
 * workaround. Both times the check reported a packaging problem when packaging
 * was fine.
 *
 * The lesson is the one this file is about: a measurement whose result depends
 * on incidental properties of how it was invoked is not measuring the thing it
 * claims to. So this stops parsing a text stream that other tools are entitled
 * to write to, and inspects the artifact instead — which is also what the
 * requirement actually asks for.
 *
 * **Why `npm pack` runs against a SCRATCH COPY, not this repo (found
 * 2026-09-18, root-caused after two intermittent `scip-cli.test.ts` failures
 * — "Cannot find module .../dist/cli/index.js").** This used to run
 * `execFileSync("npm", ["pack", ..., "--ignore-scripts"], { cwd: ROOT, ... })`
 * directly against the repo. `--ignore-scripts` (and the belt-and-suspenders
 * `npm_config_ignore_scripts=true` env var) turned out not to suppress
 * `prepare` under npm 10.9.8 — reproduced standalone: a bare
 * `npm pack --ignore-scripts` in this repo still runs `tsup && husky` and
 * prints its build progress. `tsup.config.ts` sets `clean: true`, so that
 * unwanted rebuild deletes `dist/` before repopulating it — a window any
 * OTHER concurrently-running test that spawns `dist/cli/index.js` can land
 * in and see `MODULE_NOT_FOUND`, which is exactly what happened.
 *
 * The fix does not try to suppress the script more forcefully (the next npm
 * version could reintroduce the same gap through a different corner). It
 * removes the precondition for the bug to matter at all: `npm pack` now runs
 * inside a throwaway copy of just the packaging inputs, whose `package.json`
 * has its `scripts` field deleted entirely — there is no `prepare` script
 * for ANY npm version's `--ignore-scripts` handling to get wrong, and even a
 * rebuild triggered there could only ever touch the scratch copy, never this
 * repo's own `dist/` (see the `packedFiles() does not touch this repo's own
 * dist/` guard test below, which fails hard against the old implementation —
 * checked before writing this fix, not assumed).
 *
 * **This still measures the real, declared `files` field, not itself.** The
 * copy step below does not decide what ships — it only stages, from the
 * REAL repo, exactly the inputs a real `npm pack` needs to make that call
 * for itself: every path this repo's OWN `package.json.files` names (copied
 * verbatim, so a typo or a path that does not resolve here throws loudly,
 * during the copy, rather than silently vanishing from the tarball the way
 * it would in production), plus `README.md`/`LICENSE` copied a second,
 * independent way (not derived from `files` — these are already listed
 * there today, but this guards against them being removed from `files`
 * later while npm's own always-include behavior would still ship them,
 * which would make a `files`-derived-only copy silently stop testing that
 * case). The unmodified, REAL `files` field then travels into the copy
 * inside the trimmed `package.json`, and a REAL `npm pack` — not a
 * hand-rolled copy-and-compare — decides the final tarball contents from
 * it, same as it would for an actual `npm publish`.
 */
function packedFiles(): string[] {
  const packRoot = mkdtempSync(join(tmpdir(), "egr-pack-root-"));
  const destDir = mkdtempSync(join(tmpdir(), "egr-pack-dest-"));
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      files: string[];
      scripts?: Record<string, string>;
    };
    if (!pkg.files || pkg.files.length === 0) {
      throw new Error("package.json has no (or an empty) files field — this check cannot run");
    }

    // The one line that actually fixes the bug: no `scripts` key at all means
    // no `prepare` for any npm version to run, regardless of `--ignore-scripts`.
    const { scripts: _scripts, ...pkgWithoutScripts } = pkg;
    writeFileSync(join(packRoot, "package.json"), JSON.stringify(pkgWithoutScripts, null, 2));

    // Every path package.json.files names, copied from the REAL repo — not
    // hand-typed here, so a typo in `files` surfaces as a copy failure
    // (ENOENT) instead of silently shrinking the tarball.
    for (const entry of pkg.files) {
      cpSync(join(ROOT, entry), join(packRoot, entry), { recursive: true });
    }
    // README/LICENSE, independently of whatever `files` currently says — see
    // this function's doc comment for why.
    for (const alwaysShipped of ["README.md", "LICENSE"]) {
      cpSync(join(ROOT, alwaysShipped), join(packRoot, alwaysShipped));
    }

    execFileSync("npm", ["pack", "--pack-destination", destDir, "--ignore-scripts"], {
      cwd: packRoot,
      // stdout is deliberately ignored — nothing here reads it, so nothing here
      // can be broken by what npm or a lifecycle script decides to print.
      stdio: "ignore",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });

    const tarball = readdirSync(destDir).find((f) => f.endsWith(".tgz"));
    if (!tarball) {
      throw new Error(
        `npm pack produced no tarball in ${destDir}; this check cannot run`,
      );
    }

    const listing = execFileSync("tar", ["-tzf", join(destDir, tarball)], {
      encoding: "utf8",
    });
    return listing
      .split("\n")
      .filter(Boolean)
      // npm wraps everything in a top-level `package/` directory.
      .map((entry) => entry.replace(/^package\//, ""))
      // Directory entries end in a slash on some tar implementations.
      .filter((entry) => entry !== "" && !entry.endsWith("/"));
  } finally {
    rmSync(packRoot, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  }
}

describe("the published tarball contains what the install hooks need", () => {
  const files = packedFiles();

  it("returned a plausible file list at all", () => {
    // Guard the query before trusting its result: an empty or tiny list means
    // the pack itself misbehaved, and every assertion below would then be
    // failing for the wrong reason — or, worse, a future refactor could make
    // this return [] and the `toContain` checks would fail in a way that reads
    // like a packaging regression.
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.startsWith("dist/"))).toBe(true);
  });

  for (const required of [
    // Runs before dependencies are installed — cannot come from dist/.
    "preinstall.js",
    // Read by preinstall.js at install time. Bundled into dist/ as well, but
    // dist/ does not exist yet when preinstall runs, so the root copy ships.
    "language-support.js",
  ]) {
    it(`ships ${required}`, () => {
      expect(files).toContain(required);
    });
  }

  it("does not ship the dev-only type declarations", () => {
    // Nothing consumes these outside this repo — `dist/index.d.ts` inlines the
    // types. Shipping them is harmless but signals they are part of the public
    // surface, which they are not.
    expect(files).not.toContain("language-support.d.ts");
    expect(files).not.toContain("preinstall.d.ts");
  });

  it("no longer ships postinstall.js", () => {
    // Removed in 0.9.1. It ran an MCP registration notice that npm suppressed,
    // so it delivered nothing while looking like a feature; its content moved
    // to `egr --help` and `egr doctor`, which npm cannot silence. Asserted
    // rather than merely deleted so a revert has to be deliberate.
    expect(files).not.toContain("postinstall.js");
  });
});

/**
 * `packedFiles()` must not be able to touch THIS repo's own `dist/`.
 *
 * Root cause (found 2026-09-18, chasing an intermittent
 * `test/scip-cli.test.ts` failure — "Cannot find module .../dist/cli/index.js"
 * twice under `npm test`'s pre-commit run): `packedFiles()` used to run
 * `npm pack --ignore-scripts` with `cwd: ROOT`, i.e. THIS repo. npm 10.9.8
 * runs the `prepare` script (`tsup && husky`) regardless of `--ignore-scripts`
 * / `npm_config_ignore_scripts=true` — reproduced directly: a standalone
 * `npm pack --ignore-scripts` in this repo still prints `> ... prepare` /
 * `CLI Building entry...` on stdout. `tsup.config.ts` has `clean: true`, so
 * that rebuild deletes `dist/` before repopulating it. Any OTHER test running
 * concurrently in the same `vitest run` that spawns `dist/cli/index.js` (this
 * file's own suite runs alongside `scip-cli.test.ts`, `doctor.test.ts`, etc.)
 * can land its spawn inside that empty window and see `MODULE_NOT_FOUND` —
 * exactly the two intermittent failures this guard exists to prevent from
 * ever silently regressing again.
 *
 * The fix (see `packedFiles()` above) makes the failure mode structurally
 * impossible rather than merely less likely: `npm pack` now runs against a
 * SCRATCH COPY of the packaging inputs whose `package.json` has no `scripts`
 * key at all, so there is no `prepare` for ANY npm version's `--ignore-scripts`
 * handling to get wrong — not "less likely to touch dist/", but "physically
 * pointed at a directory that is not this repo".
 */
describe("packedFiles() does not touch this repo's own dist/", () => {
  it("dist/cli/index.js's inode and mtime are unchanged after packedFiles() ran", () => {
    const after = statSync(DIST_CLI_INDEX);
    expect(after.ino, "inode changed — dist/cli/index.js was deleted and recreated").toBe(
      distCliIndexBefore.ino,
    );
    expect(after.mtimeMs, "mtime changed — dist/cli/index.js was rewritten").toBe(
      distCliIndexBefore.mtimeMs,
    );
  });
});
