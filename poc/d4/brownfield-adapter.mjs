/**
 * XSPEC-237 D4 — brownfield-task → BuilderInput adapter.
 *
 * VibeOps's Builder consumes a greenfield-pipeline-shaped input
 * (`source_agent: "ui-ux"` + `upstream_summary` + `depends_on_artifacts`) and
 * reads the full spec from `artifacts/`. This adapter encodes a brownfield
 * "modify function X, update its callers" task into that shape **without
 * changing any VibeOps code** (DEC-070):
 *
 *   - a schema-valid BuilderInput JSON (the change summarised in
 *     upstream_summary / assumptions), and
 *   - a companion designer spec artifact carrying the change description, the
 *     existing source (inlined, so tool-less providers also work), the
 *     acceptance criteria derived from the task, and — for the TREATMENT arm
 *     only — the CodeSage call-chain context.
 *
 * Control and treatment differ by exactly one thing: the call-chain block.
 */

/** Required top-level keys of BuilderInput (from agents/builder/input-schema.json). */
export const BUILDER_INPUT_REQUIRED = [
  "version",
  "source_agent",
  "created_at",
  "upstream_summary",
  "depends_on_artifacts",
];

const UPSTREAM_REQUIRED = ["prd_title", "prd_version", "tech_stack", "key_decisions"];

/**
 * Build a BuilderInput + designer spec artifact for a brownfield task.
 *
 * @param {object}  task          one entry from tasks.json
 * @param {{path:string,source:string}[]} fixtureFiles  the existing codebase
 * @param {{callers:string[],callees:string[],block:string}|null} callChain
 *        CodeSage context for the treatment arm; null for control
 * @param {string}  createdAt     ISO timestamp (passed in for determinism)
 * @returns {{ builderInput: object, specArtifact: object, specPath: string }}
 */
export function toBuilderInput(task, fixtureFiles, callChain, createdAt) {
  const acceptanceCriteria = [
    `${task.type} on \`${task.targetSymbol}\` in ${task.targetFile}: ${task.description}`,
    task.groundTruthCallers.length > 0
      ? `Update every caller so the project still builds and all tests pass: ${task.groundTruthCallers.join(", ")}.`
      : "This is an internal change; no caller should need to be modified.",
    "Preserve existing behaviour for all currently-passing tests (no regressions).",
  ];

  const specArtifact = {
    version: "1.0.0",
    source_agent: "designer",
    created_at: createdAt,
    detailed_specifications: {
      task_id: task.id,
      change_type: task.type,
      target_symbol: task.targetSymbol,
      target_file: task.targetFile,
      change_description: task.description,
      existing_code: Object.fromEntries(fixtureFiles.map((f) => [f.path, f.source])),
      acceptance_criteria: acceptanceCriteria,
    },
    test_plan: {
      run: "npm test",
      note: "Existing fixture tests must stay green; update them only if the change makes a test's expectation obsolete.",
    },
    // TREATMENT-only: CodeSage call-chain context. Absent in control.
    ...(callChain
      ? {
          call_chain_context: {
            symbol: callChain.symbol,
            callers: callChain.callers,
            callees: callChain.callees,
            note: "Provided by CodeSage. These are the direct call sites to review/update.",
          },
        }
      : {}),
  };

  const specPath = `artifacts/design/designer-d4-${task.id}.json`;

  const builderInput = {
    version: "1.0.0",
    source_agent: "ui-ux",
    created_at: createdAt,
    depends_on_artifacts: [
      { agent: "architect", version: "1.0.0" },
      { agent: "designer", version: "1.0.0" },
    ],
    upstream_summary: {
      prd_title: `Brownfield ${task.type}: ${task.targetSymbol} (${task.id})`,
      prd_version: "1.0.0",
      tech_stack: "TypeScript (Node.js, ESM, vitest)",
      key_decisions: [
        `Modify \`${task.targetSymbol}\` in ${task.targetFile}.`,
        task.description,
        `Read the full spec (existing code + acceptance criteria${callChain ? " + call-chain context" : ""}) from ${specPath}.`,
      ],
    },
    skip_reason: "Brownfield code modification — no new UI surface.",
    passthrough: true,
    assumptions: [
      "The codebase already exists; emit patches[] (unified diff) for modified files.",
      callChain
        ? `Callers of ${task.targetSymbol} per CodeSage: ${callChain.callers.join(", ") || "(none)"}.`
        : "No call-chain hints provided; locate call sites yourself.",
    ],
  };

  return { builderInput, specArtifact, specPath };
}

/** Structurally validate a BuilderInput against the known schema constraints. */
export function validateBuilderInput(input) {
  const errors = [];
  for (const k of BUILDER_INPUT_REQUIRED) {
    if (!(k in input)) errors.push(`missing required key: ${k}`);
  }
  if (input.source_agent !== "ui-ux") errors.push(`source_agent must be "ui-ux"`);
  if (typeof input.version !== "string" || !/^\d+\.\d+\.\d+$/.test(input.version)) {
    errors.push(`version must match \\d+.\\d+.\\d+`);
  }
  if (!Array.isArray(input.depends_on_artifacts)) {
    errors.push("depends_on_artifacts must be an array");
  }
  const us = input.upstream_summary;
  if (typeof us !== "object" || us === null) {
    errors.push("upstream_summary must be an object");
  } else {
    for (const k of UPSTREAM_REQUIRED) {
      if (!(k in us)) errors.push(`upstream_summary missing: ${k}`);
    }
    if (!Array.isArray(us.key_decisions)) errors.push("upstream_summary.key_decisions must be an array");
  }
  return errors;
}
