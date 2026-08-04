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
 */

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
}
