/**
 * Install-time preflight. // implements XSPEC-365 R1
 *
 * Runs before any native dependency is compiled and says, in advance, what
 * this machine is about to be asked to build and what happens if it can't.
 * The ordering is not incidental — it is the whole point, and it was measured
 * rather than assumed: a package's own `preinstall` runs before its
 * dependencies' `install` scripts (where `node-gyp` lives), both when the
 * package is the install target and when it is a dependency of someone else's
 * project. See XSPEC-365 appendix A.
 *
 * **What it checks, and what it deliberately does not.** It compares this
 * platform against the prebuilt-binary coverage declared in
 * `language-support.js`. It does *not* try to detect whether a C/C++ toolchain
 * is present. That was a considered choice: toolchain detection is exactly
 * what fails confusingly here. `node-gyp` itself hard-codes support for Visual
 * Studio 2017/2019/2022 and reports a machine with a complete VS 2026 MSVC
 * install as `unknown version "undefined"`; and the `VCTools` workload lists
 * the actual compiler as Recommended rather than Required, so a machine can
 * report a C++ workload while having no compiler. A second, worse detector in
 * an install script would add noise, not signal. "Does this platform have a
 * prebuilt binary" is deterministic, needs nothing installed to answer, and is
 * the same question `node-gyp-build` will ask a moment later.
 *
 * **It never fails the install.** Every path exits 0, including the failure
 * paths of this script itself. Blocking installation would leave the user with
 * no `egr` at all, when the actual consequence is losing one language out of
 * thirteen.
 *
 * **This is best-effort, and is NOT how the information reaches users.**
 * Measured on 2026-08-04 with the command people actually type
 * (`npm install -g engramgraph`, no `--foreground-scripts`): this notice
 * appeared zero times in 242 lines of output. npm suppresses lifecycle-script
 * output by default, and npm >= 11 additionally holds those scripts behind an
 * approval gate, so on a fresh machine the script may not run at all. Every
 * test of this file had passed, because every test invoked it the way it was
 * written rather than the way users install — the same mistake, in miniature,
 * that this whole release is about.
 *
 * It is kept because it costs nothing and does surface where script output is
 * shown (CI logs, `--foreground-scripts`, `npm_config_foreground_scripts`),
 * and it is the only thing that can speak *before* a compile. But the channel
 * users actually see is `egr doctor` and the skipped-language line at index
 * time — a command someone types cannot be suppressed by a package manager.
 */

import { readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { compiledFromSourceOn, currentPlatform } from "./language-support.js";

const DOCS =
  "https://github.com/AsiaOstrich/EngramGraph#native-dependencies-and-platform-support";

/**
 * The preflight message for `platform`, or `null` when nothing there needs
 * compiling.
 *
 * Exported and pure so `test/preinstall.test.ts` can assert what each platform
 * is told without running an install. An install-time message that is only
 * ever exercised during an install is a message nobody checks: it renders on
 * exactly the machines where something is going wrong, which are the machines
 * whose output nobody is reading.
 *
 * @param {string} [platform] Defaults to the running platform.
 * @returns {string | null}
 */
export function preflightMessage(platform = currentPlatform()) {
  const fromSource = compiledFromSourceOn(platform);
  if (fromSource.length === 0) return null; // fully prebuilt here; say nothing

  const lines = [
    "",
    `engramgraph: ${fromSource.length === 1 ? "one native dependency has" : `${fromSource.length} native dependencies have`} no prebuilt binary for ${platform},`,
    "so npm is about to compile from source:",
    "",
  ];

  for (const dep of fromSource) {
    const what =
      dep.kind === "grammar"
        ? `provides ${dep.languages.join(", ")} support`
        : dep.role;
    lines.push(`  ${dep.package}  —  ${what}`);
  }

  const grammarsOnly = fromSource.every((d) => d.kind === "grammar");
  const languages = fromSource.flatMap((d) => d.languages);

  lines.push(
    "",
    "Compiling needs a C/C++ toolchain and Python on this machine.",
  );

  if (grammarsOnly) {
    lines.push(
      "",
      "If they are missing the build will fail, and that is expected, not fatal:",
      `these grammars are optional dependencies, so installation continues and`,
      `every other language still works. Only ${languages.join(", ")} indexing`,
      "would be unavailable, and egr will say so when you index.",
    );
  } else {
    // A non-grammar native dependency (the graph database) is not optional —
    // be honest that this one is load-bearing rather than implying the same
    // graceful degradation.
    lines.push(
      "",
      "At least one of these is required, not optional — if its build fails,",
      "the installation will not produce a working egr.",
    );
  }

  lines.push("", `Platform notes and setup steps: ${DOCS}`, "");

  return lines.join("\n");
}

/**
 * Directories npm names `.engramgraph-<hash>` inside a `node_modules`. // implements issue #26
 *
 * When npm replaces a package it first renames the installed copy to
 * `.<name>-<hash>`, unpacks the new one, and deletes the renamed copy at the end.
 * The hash is 8 characters derived from the SHA-1 of the package's path (base64, non-alphanumerics removed)
 * (`@npmcli/arborist/lib/retire-path.js`), so it is the SAME name on every
 * upgrade. On Windows the delete fails while a running `egr-mcp` holds
 * `ryugraph\ryujs.node` open, the directory stays, and the next upgrade then has
 * to rename onto that name and fails with EBUSY (issue #26).
 *
 * **What this can and cannot do — measured with npm 10.9.9 in a scratch
 * `--prefix`, 2026-11-05.** `preinstall` runs from the new package's own
 * directory, AFTER npm has retired the old copy (retire is the first reify step,
 * lifecycle scripts run in the last), so:
 *
 *  - It can NOT stop the failing upgrade. When the leftover is in the way, npm
 *    fails at the rename, before the new package's `preinstall` exists to run.
 *    (Reproduced with a non-empty `.engramgraph-<hash>` in place: ENOTEMPTY on
 *    macOS, EBUSY on Windows; the hook printed nothing.)
 *  - On every ordinary upgrade it SEES npm's own in-flight copy of the previous
 *    version, same name, a whole package tree with a `package.json` at its root.
 *    That is not a leftover; reporting it would warn on every upgrade. A tree
 *    that has lost its `package.json` is not a retired copy any more, so only
 *    those are reported. (Windows deletes what it can and keeps the locked file,
 *    but exactly what remains was not observed. If a leftover still has its
 *    `package.json`, this stays silent: a missed warning, never a false one.)
 *  - Where it does reach someone is a FRESH install next to a leftover (after
 *    `npm uninstall -g`, or after the package directory was removed by hand),
 *    and — like all of this file — only when npm shows script output.
 *
 * It warns and nothing else. Pure, so a test can call it without an install.
 *
 * @param {string} [packageDir] The directory the hook runs in (the package root).
 * @returns {string[]} Names of leftover directories next to it, sorted.
 */
export function findUpgradeLeftovers(packageDir = process.cwd()) {
  if (basename(packageDir) !== "engramgraph") return []; // not an installed copy (repo checkout, CI)
  const parent = dirname(packageDir);
  if (basename(parent) !== "node_modules") return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name.startsWith(".engramgraph-") &&
        !existsSync(join(parent, e.name, "package.json")),
    )
    .map((e) => e.name)
    .sort();
}

/**
 * The warning for the leftovers `findUpgradeLeftovers` found, or `null` when
 * there are none.
 *
 * @param {string[]} names
 * @param {string} [packageDir]
 * @returns {string | null}
 */
export function leftoverMessage(names, packageDir = process.cwd()) {
  if (names.length === 0) return null;
  const parent = dirname(packageDir);
  return [
    "",
    `engramgraph: ${names.length === 1 ? "an earlier upgrade left" : "earlier upgrades left"} ${names.join(", ")} in ${parent}.`,
    "npm renames the installed copy to that name while it upgrades and deletes it at the end;",
    "on Windows it cannot while a running egr-mcp holds ryugraph\\ryujs.node open.",
    "Left there, the next upgrade can fail with EBUSY on Windows and leave the install half old, half new.",
    "",
    "This install carries on. Before the next upgrade: close every MCP client that runs",
    `egr-mcp (for example Claude Code), then delete ${names.map((n) => join(parent, n)).join(", ")}.`,
    "Details: https://github.com/AsiaOstrich/EngramGraph/blob/main/docs/MCP.md (\"Windows: upgrading while egr-mcp is running\").",
    "",
  ].join("\n");
}

/**
 * Only speak when run as the install hook, so importing this module from a
 * test doesn't print to the terminal.
 */
const RUN_AS_HOOK = process.argv[1]?.endsWith("preinstall.js") ?? false;

if (RUN_AS_HOOK) {
  try {
    const message = preflightMessage();
    if (message !== null) console.error(message);
  } catch (err) {
    // A preflight that breaks the install is worse than no preflight. Report
    // and get out of the way — npm proceeds exactly as it would have.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`engramgraph: install preflight skipped (${reason})`);
  }
  // Its own try: a failure here must not hide the platform notice above, and a
  // failure above must not hide this one. Still exit 0 either way.
  try {
    const message = leftoverMessage(findUpgradeLeftovers());
    if (message !== null) console.error(message);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`engramgraph: leftover check skipped (${reason})`);
  }
}
