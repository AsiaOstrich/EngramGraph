// SPDX-License-Identifier: MIT
// implements XSPEC-476
/**
 * Preload (`node --import`) that records every `git` process the program under
 * test starts, one JSON array of its arguments per line, into the file named by
 * `EGR_GIT_CALL_LOG`.
 *
 * Why this exists: "`egr refs check` no longer runs git once per reference" is a
 * statement about how many processes a run starts. Timing it is flaky and a
 * green run on a small fixture proves nothing about 213 references, so the test
 * counts the calls instead and shows the count does not grow with the document.
 *
 * It wraps the child_process functions in place and then re-syncs the builtin's
 * ES-module exports, so code that did `import { execFileSync } from
 * "node:child_process"` sees the wrapper. No product code knows about it.
 */
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";

const logFile = process.env.EGR_GIT_CALL_LOG;

if (logFile) {
  for (const name of ["execFileSync", "execFile", "spawnSync", "spawn"]) {
    const original = cp[name];
    cp[name] = function (file, args, ...rest) {
      if (file === "git" && Array.isArray(args)) appendFileSync(logFile, JSON.stringify(args) + "\n");
      return original.call(this, file, args, ...rest);
    };
  }
  syncBuiltinESMExports();
}
