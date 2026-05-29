/**
 * XSPEC-237 D4 — real BUILDER_CMD wrapper (VibeOps Builder via subscription OAuth).
 *
 * The rest of the harness (workspace prep, output parse/apply, fixture tests,
 * metrics) is validated via fake-builder.mjs. This wrapper is the real-LLM seam.
 * Its config-injection + selection logic was checked against VibeOps source
 * (router.ts / config.ts / agent-runner.ts); the remaining unverified-until-a-
 * -real-run assumptions are flagged ⚠️ below.
 *
 * Contract (env, set by run-experiment.mjs): D4_INPUT, D4_WORKSPACE, D4_OUTPUT,
 * D4_TASK. Also required: VIBEOPS_DIR; CLAUDE_CODE_OAUTH_TOKEN (from
 * `claude setup-token`). Do NOT set ANTHROPIC_API_KEY (so the SDK uses the
 * subscription OAuth path, not paid API billing).
 *
 *   claude setup-token
 *   export CLAUDE_CODE_OAUTH_TOKEN=<token>
 *   MODE=real VIBEOPS_DIR=../vibeops \
 *     BUILDER_CMD="node poc/d4/vibeops-builder-cmd.mjs" node poc/d4/run-experiment.mjs
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { D4_INPUT, D4_WORKSPACE, D4_OUTPUT, D4_TASK, VIBEOPS_DIR } = process.env;
const MODEL = process.env.D4_MODEL ?? "claude-sonnet-4-6";

if (!VIBEOPS_DIR) throw new Error("set VIBEOPS_DIR to the vibeops repo path");
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  throw new Error("set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`); leave ANTHROPIC_API_KEY unset");
}

const artifactsDir = join(D4_WORKSPACE, "artifacts");

// 1. Inject a claude-agent-sdk provider and select it for the Builder.
//    - capabilities:["coding"] is REQUIRED: AGENT_CAPABILITY_MAP.builder=["coding"]
//      and router.resolveProviderConfig picks the agent-default provider only if
//      it has the needed capability — otherwise it falls through to some other
//      capable provider. (verified against router.ts)
//    - no apiKeyEnv → ClaudeAgentSDKProvider leaves auth to the ambient env,
//      i.e. CLAUDE_CODE_OAUTH_TOKEN (verified against factory.ts + provider).
//    - sandbox.localWorkDir = workspace → the SDK's file tools (Read/Edit)
//      operate on the fixture copy (factory passes cwd: config.sandbox.localWorkDir).
//    - do NOT set config.projectPath: agent-runner reads AGENTS.md from
//      projectPath ?? cwd; leaving it default keeps it at VIBEOPS_DIR (where the
//      cli runs and AGENTS.md exists). (verified against agent-runner.ts)
//    loadConfig does a plain JSON.parse with no schema validation, so these
//    extra fields are safe. (verified against config.ts)
const config = JSON.parse(readFileSync(join(VIBEOPS_DIR, "vibeops.config.json"), "utf8"));
config.providers ??= {};
config.providers["codesage-poc"] = {
  type: "claude-agent-sdk",
  model: MODEL,
  capabilities: ["coding"],
  sandbox: { localWorkDir: D4_WORKSPACE },
};
config.agents ??= {};
config.agents.builder = { ...(config.agents.builder ?? {}), provider: "codesage-poc" };
config.pipeline ??= {};
config.pipeline.artifactsDir = artifactsDir;

const cfgPath = join(tmpdir(), `d4-vibeops-config-${D4_TASK}.json`);
writeFileSync(cfgPath, JSON.stringify(config, null, 2));

// 2. Run the Builder agent. cwd = VIBEOPS_DIR (agents/builder/prompt.md +
//    AGENTS.md resolve from cwd). ⚠️ ASSUMPTION (real-run only): the Builder, via
//    claude-agent-sdk Read/Edit tools at cwd=workspace, reads the spec artifact
//    (workspace/artifacts/design/designer-d4-*.json) and emits files[]/patches[]
//    in this standalone `run` path. Confirm on first real run.
execSync(`npx tsx src/infrastructure/cli/cli.ts run builder --input "${D4_INPUT}"`, {
  cwd: VIBEOPS_DIR,
  stdio: "inherit",
  env: { ...process.env, VIBEOPS_CONFIG_PATH: cfgPath },
});

// 3. Read the Builder output from the saved artifact (robust — avoids parsing
//    interleaved stdout logs). agent-runner saves to <artifactsDir>/code/
//    builder-<timestamp>.json. (verified: artifactDir("builder")="code")
const codeDir = join(artifactsDir, "code");
if (!existsSync(codeDir)) throw new Error(`no builder artifact dir: ${codeDir}`);
const newest = readdirSync(codeDir)
  .filter((f) => f.startsWith("builder-") && f.endsWith(".json"))
  .map((f) => ({ f, m: statSync(join(codeDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];
if (!newest) throw new Error(`no builder-*.json in ${codeDir}`);
const result = JSON.parse(readFileSync(join(codeDir, newest.f), "utf8"));
writeFileSync(D4_OUTPUT, JSON.stringify(result, null, 2));
console.log(`[vibeops-builder] ${D4_TASK}: captured ${newest.f}`);
