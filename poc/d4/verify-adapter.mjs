/**
 * XSPEC-237 D4 — verify the brownfield→BuilderInput adapter.
 *
 * Builds control + treatment BuilderInput for every task (using REAL CodeSage
 * call-chain context) and checks: schema-valid; treatment carries the
 * call_chain_context and control does not; the spec artifact inlines the
 * existing code + acceptance criteria. No LLM required.
 *
 * Usage (CodeSage repo root, after `npm run build`):
 *   node poc/d4/verify-adapter.mjs
 */

import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { GraphConnection, initSchema, indexProject, callChain } from "../../dist/index.js";
import { toBuilderInput, validateBuilderInput } from "./brownfield-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "fixture", "src");
const STAMP = "2026-05-30T00:00:00.000Z";

const tasks = JSON.parse(readFileSync(join(HERE, "tasks.json"), "utf8"));
const fixtureFiles = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ path: `src/${f}`, source: readFileSync(join(SRC, f), "utf8") }));

const dbDir = join(tmpdir(), "codesage-d4-adapter");
rmSync(dbDir, { recursive: true, force: true });
mkdirSync(dbDir, { recursive: true });
const conn = GraphConnection.open(join(dbDir, "graph.db"));
await initSchema(conn);
await indexProject(conn, fixtureFiles);

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`FAIL  ${msg}`);
  }
}

for (const task of tasks.tasks) {
  const chain = await callChain(conn, task.targetSymbol, "callers", 1);
  const ctx = { symbol: task.targetSymbol, callers: chain.callers.map((c) => c.name), callees: [] };

  const control = toBuilderInput(task, fixtureFiles, null, STAMP);
  const treatment = toBuilderInput(task, fixtureFiles, ctx, STAMP);

  // 1. both arms produce schema-valid BuilderInput
  const cErr = validateBuilderInput(control.builderInput);
  const tErr = validateBuilderInput(treatment.builderInput);
  check(cErr.length === 0, `${task.id} control invalid: ${cErr.join("; ")}`);
  check(tErr.length === 0, `${task.id} treatment invalid: ${tErr.join("; ")}`);

  // 2. treatment carries call-chain; control does not
  check(!("call_chain_context" in control.specArtifact), `${task.id} control must NOT have call_chain_context`);
  check("call_chain_context" in treatment.specArtifact, `${task.id} treatment must have call_chain_context`);

  // 3. spec artifact inlines existing code + acceptance criteria
  check(
    Object.keys(treatment.specArtifact.detailed_specifications.existing_code).length === fixtureFiles.length,
    `${task.id} spec must inline all ${fixtureFiles.length} source files`,
  );
  check(
    treatment.specArtifact.detailed_specifications.acceptance_criteria.length >= 2,
    `${task.id} spec must have acceptance criteria`,
  );

  // 4. treatment's call-chain reflects the TRUE call graph (who calls the
  //    symbol), which is distinct from groundTruthCallers (who must be UPDATED).
  //    For internal-refactor negative controls these differ on purpose — the
  //    discriminating signal the PoC measures.
  const ctxCallers = [...treatment.specArtifact.call_chain_context.callers].sort();
  const trueCallers = [...(tasks.callGraph[task.targetSymbol] ?? [])].sort();
  check(
    JSON.stringify(ctxCallers) === JSON.stringify(trueCallers),
    `${task.id} call-chain callers ${JSON.stringify(ctxCallers)} != true call graph ${JSON.stringify(trueCallers)}`,
  );

  const mustUpdate = task.groundTruthCallers.length;
  console.log(
    `OK    ${task.id} (${task.type}, helps=${task.shouldCallChainHelp}) — valid; ` +
      `call-chain=[${ctxCallers.join(", ") || "none"}], must-update=${mustUpdate}`,
  );
}

rmSync(dbDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} adapter check(s) failed.`);
  process.exit(1);
}
console.log("\nAdapter OK — all tasks produce valid control/treatment BuilderInput (+ matching call-chain).");
process.exit(0);
