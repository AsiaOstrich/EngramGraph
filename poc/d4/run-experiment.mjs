/**
 * XSPEC-237 D4 PoC — A/B experiment runner (P5).
 *
 * Orchestrates: index fixture → per task, generate CodeSage call-chain context
 * → run the Builder for control (no context) and treatment (+ context) arms →
 * collect metrics → aggregate → apply the pre-registered GO/NO-GO gate.
 *
 * The REAL parts (call-chain generation, arm construction, metrics,
 * aggregation, GO/NO-GO) run here. The Builder invocation is behind a
 * pluggable adapter:
 *
 *   MODE=mock  (default) — a NEUTRAL synthetic builder (identical result for
 *              both arms). Validates the harness wiring end-to-end; it is NOT a
 *              measurement and deliberately yields no signal (tie → NO-GO).
 *   MODE=real  — shells out to the VibeOps Builder. Requires an LLM provider
 *              key AND a brownfield-task → BuilderInput adapter (the Builder's
 *              input is greenfield-pipeline-shaped). Not runnable without those.
 *
 * Usage (from CodeSage repo root, after `npm run build`):
 *   node poc/d4/run-experiment.mjs            # mock smoke
 *   N=5 node poc/d4/run-experiment.mjs        # 5 runs/arm/task (mock)
 *   MODE=real VIBEOPS_DIR=../vibeops node poc/d4/run-experiment.mjs   # real (needs key)
 */

import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileSync } from "node:fs";
import { GraphConnection, initSchema, indexProject, callChain } from "../../dist/index.js";
import { toBuilderInput, validateBuilderInput } from "./brownfield-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "fixture", "src");
const MODE = process.env.MODE ?? "mock";
const N = Number(process.env.N ?? (MODE === "mock" ? 2 : 5));

// Pre-registered GO/NO-GO thresholds (design §6).
const GATE = { missedCallSitesDropPct: 50, firstPassGainPct: 20 };

const tasks = JSON.parse(readFileSync(join(HERE, "tasks.json"), "utf8"));
const fixtureFiles = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ path: `src/${f}`, source: readFileSync(join(SRC, f), "utf8") }));

// --- 1. Index fixture + generate per-task call-chain context (REAL) ----------

async function buildContexts() {
  const dbDir = join(tmpdir(), "codesage-d4-exp");
  rmSync(dbDir, { recursive: true, force: true });
  mkdirSync(dbDir, { recursive: true });
  const conn = GraphConnection.open(join(dbDir, "graph.db"));
  await initSchema(conn);
  await indexProject(conn, fixtureFiles);

  const contexts = {};
  for (const task of tasks.tasks) {
    // depth 1 = direct callers/callees — the exact set that must change on a
    // signature/behaviour change (matches groundTruthCallers semantics).
    const chain = await callChain(conn, task.targetSymbol, "both", 1);
    contexts[task.id] = {
      symbol: task.targetSymbol,
      callers: chain.callers.map((c) => c.name),
      callees: chain.callees.map((c) => c.name),
      block:
        `## Call chain for ${task.targetSymbol} (from CodeSage)\n` +
        `Callers (update these if the signature/behaviour changes): ` +
        `${chain.callers.map((c) => `${c.name} (${c.file})`).join(", ") || "(none)"}\n` +
        `Callees: ${chain.callees.map((c) => c.name).join(", ") || "(none)"}`,
    };
  }
  // do NOT await conn.close() — kuzu native close segfaults with tree-sitter loaded
  return contexts;
}

// --- 2. Builder adapter (pluggable) -----------------------------------------

/**
 * @returns {{ updatedCallers: string[], firstPassPass: boolean, iterations: number, costUSD: number }}
 */
async function runBuilder(task, arm, ctx) {
  if (MODE === "real") {
    // 1. Adapter (wired): brownfield task → schema-valid BuilderInput + spec.
    const stamp = new Date().toISOString();
    const { builderInput, specArtifact, specPath } = toBuilderInput(
      task,
      fixtureFiles,
      arm === "treatment" ? ctx : null,
      stamp,
    );
    const errors = validateBuilderInput(builderInput);
    if (errors.length) throw new Error(`adapter produced invalid BuilderInput: ${errors.join("; ")}`);
    const stage = join(tmpdir(), `codesage-d4-real-${task.id}-${arm}`);
    mkdirSync(join(stage, dirname(specPath)), { recursive: true });
    writeFileSync(join(stage, "builder-input.json"), JSON.stringify(builderInput, null, 2));
    writeFileSync(join(stage, specPath), JSON.stringify(specArtifact, null, 2));

    // 2. Invoke VibeOps Builder (blocked here): needs a workspace copy of the
    //    fixture, an LLM provider key, then `vibeops run builder --input
    //    <builder-input.json>`; apply patches → run fixture tests → diff
    //    touched files vs task.groundTruthCallers for the metrics below.
    throw new Error(
      `MODE=real: valid BuilderInput staged at ${stage}, but invoking the VibeOps Builder ` +
        `requires VIBEOPS_DIR + an LLM provider key (none in this sandbox). See poc/d4/README.md.`,
    );
  }
  // MODE=mock — NEUTRAL synthetic result: identical for both arms, so the
  // experiment yields NO signal by construction. Purpose: validate the harness
  // plumbing only. These numbers are SYNTHETIC, not a measurement.
  void arm;
  void ctx;
  return {
    updatedCallers: [...task.groundTruthCallers], // both arms "update" all → no diff
    firstPassPass: true,
    iterations: 1,
    costUSD: 0.01,
  };
}

// --- 3. Metrics (REAL given a builder result) -------------------------------

function metricsFor(task, builderResult) {
  const want = new Set(task.groundTruthCallers);
  const got = new Set(builderResult.updatedCallers);
  let missed = 0;
  for (const c of want) if (!got.has(c)) missed++;
  return {
    missedCallSites: missed,
    firstPassPass: builderResult.firstPassPass ? 1 : 0,
    iterations: builderResult.iterations,
    costUSD: builderResult.costUSD,
  };
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// --- 4. Run + aggregate + GO/NO-GO ------------------------------------------

async function main() {
  const contexts = await buildContexts();
  const banner =
    MODE === "mock"
      ? "*** MODE=mock — SYNTHETIC neutral data, harness validation only. NOT a measurement. ***"
      : `MODE=real (N=${N})`;
  console.log(`\n${banner}\n`);

  const agg = { control: [], treatment: [] };
  const positive = { control: [], treatment: [] }; // positive-control tasks only

  for (const task of tasks.tasks) {
    for (const arm of ["control", "treatment"]) {
      for (let i = 0; i < N; i++) {
        const ctx = arm === "treatment" ? contexts[task.id] : null;
        const result = await runBuilder(task, arm, ctx);
        const m = metricsFor(task, result);
        agg[arm].push(m);
        if (task.shouldCallChainHelp) positive[arm].push(m);
      }
    }
    console.log(
      `task ${task.id} (${task.type}, helps=${task.shouldCallChainHelp}) — ` +
        `callers context: [${contexts[task.id].callers.join(", ") || "none"}]`,
    );
  }

  const summarize = (rows) => ({
    missedCallSites: mean(rows.map((r) => r.missedCallSites)),
    firstPassRate: mean(rows.map((r) => r.firstPassPass)),
    iterations: mean(rows.map((r) => r.iterations)),
    costUSD: mean(rows.map((r) => r.costUSD)),
  });

  // Decision is driven by the POSITIVE-control tasks (per design §6).
  const c = summarize(positive.control);
  const t = summarize(positive.treatment);
  const missedDropPct = c.missedCallSites === 0 ? 0 : ((c.missedCallSites - t.missedCallSites) / c.missedCallSites) * 100;
  const firstPassGainPct = c.firstPassRate === 0 ? 0 : ((t.firstPassRate - c.firstPassRate) / c.firstPassRate) * 100;
  const go = missedDropPct >= GATE.missedCallSitesDropPct || firstPassGainPct >= GATE.firstPassGainPct;

  console.log("\n--- aggregate (positive-control tasks) ---");
  console.log("control  :", c);
  console.log("treatment:", t);
  console.log(`missed call-sites drop: ${missedDropPct.toFixed(1)}% (gate ≥${GATE.missedCallSitesDropPct}%)`);
  console.log(`first-pass rate gain  : ${firstPassGainPct.toFixed(1)}% (gate ≥${GATE.firstPassGainPct}%)`);
  console.log(`\nDECISION: ${go ? "GO (build sidecar)" : "NO-GO"}${MODE === "mock" ? "  [SYNTHETIC — not a real decision]" : ""}`);
}

main();
