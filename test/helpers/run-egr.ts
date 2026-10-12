// SPDX-License-Identifier: MIT
// implements XSPEC-476
import { spawnSync } from "node:child_process";

export interface EgrRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a built `egr` entry as a child process and return what it printed — or
 * THROW, with the evidence, when it did not finish.
 *
 * Why this exists (2026-10-12, CI run 38198642143): two tests spawned the CLI
 * with a plain `spawnSync(..., { timeout })`. On a runner that was stalling
 * (unrelated in-process tests took 4–50 times longer than on the re-run of the
 * same commit) the child did not finish: the call returned after ~370 s with
 * `status: null` and empty output, and the tests then failed on
 * `expected undefined to be defined` / `Unexpected end of JSON input` — which
 * says nothing about a child that never answered. A run that did not finish is
 * not a run that answered nothing, so it is now reported as what it is, with the
 * signal, the time spent and what the child had printed.
 *
 * `SIGKILL`, not the default `SIGTERM`: a child that is merely slow can ignore
 * the polite signal for a long time. (A child stuck in the kernel will not
 * return for either; this cannot fix that, only name it.)
 */
export function runEgr(
  cli: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs?: number },
): EgrRun {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const started = Date.now();
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: opts.env,
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const elapsed = Date.now() - started;
  if (r.error || r.signal) {
    throw new Error(
      `egr ${args.join(" ")} did not finish: ${r.error?.message ?? `killed by ${r.signal}`} after ${elapsed} ms (limit ${timeoutMs} ms)\n` +
        `stdout so far (${(r.stdout ?? "").length} chars): ${(r.stdout ?? "").slice(0, 2000)}\n` +
        `stderr so far (${(r.stderr ?? "").length} chars): ${(r.stderr ?? "").slice(-2000)}`,
    );
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
