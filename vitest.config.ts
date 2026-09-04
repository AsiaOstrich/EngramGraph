import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Kuzu native bindings + temp DB files: avoid parallel DB-file contention.
    pool: "forks",
    // 30s locally, 120s on CI.
    //
    // 🔴 The number is measured, not guessed. The slowest test on a dev machine
    //    is 3.4s (scip-java-merge, gap-fill) — 9x under the 30s budget. The
    //    first CI run this repo ever had timed out 16 tests at that same 30s,
    //    so CI hardware is running these roughly an order of magnitude slower:
    //    2 cores, `pool: "forks"`, and every fork loading the Kuzu native
    //    bindings from cold. 120s keeps ~4x margin over the observed CI cost.
    //
    // ⚠️ Local stays at 30s on purpose. Raising both would hide a test that
    //    genuinely became slow — the budget is meant to be felt while writing,
    //    and only relaxed for the machine that is demonstrably slower.
    testTimeout: process.env.CI ? 120_000 : 30_000,
    // XSPEC-073 G2 — coverage was never collected here at all.
    //
    // `include` IS PART OF THE MEASUREMENT, NOT A DETAIL.
    //   First measured without any coverage config: 93.67 / 79.44 / 94.35 /
    //   94.35. That is the default behaviour — only files a test actually
    //   imported are counted, so a source file with no test at all is invisible
    //   rather than zero. With `include: src/**/*.ts` the same suite measures
    //   84.70 / 66.92 / 83.69 / 86.02. Nothing changed but the denominator.
    //   The second set is what a gate should watch: an untested file must count
    //   against coverage, not vanish from it. vibeops uses the same include.
    //
    // Thresholds pinned at measured-minus-3pt against the honest figures
    // (2026-07-29, full suite, 509 tests).
    //
    // Branches is 63, not 80. vibeops runs 80 and copying that number would
    // have failed on contact — a threshold belongs at this repo's measured
    // value minus a margin, never at another repo's.
    //
    // The 3pt margin absorbs adding a file before its tests land; it is not
    // room to regress into. Raise these when coverage rises — the step UDS
    // cli's gate never took, which left it 38 points below actual and unable to
    // fire.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        statements: 81,
        branches: 63,
        functions: 80,
        lines: 83,
      },
    },
  },
});
