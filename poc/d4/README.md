# XSPEC-237 D4 PoC — Builder call-chain injection

PoC assets to decide (data-driven) whether injecting CodeSage call-chain
context into the VibeOps Builder prompt actually improves brownfield edits.
See the full design in dev-platform `cross-project/specs/XSPEC-237-D4-poc-builder-callchain.md`
and the decision boundary in `DEC-070`.

> These files are PoC-only. They are **not** part of CodeSage's `src` build
> (excluded from `tsconfig`/`vitest`/`tsup`), so they never ship in the package.

## Contents

| Path | What |
|------|------|
| `fixture/src/*.ts` | A small multi-file TS library (money → pricing → order, inventory → order) with a non-trivial **cross-file** call graph. |
| `fixture/test/order.test.ts` | Baseline behaviour tests — the experiment measures first-pass pass / regressions against these. |
| `tasks.json` | 7 brownfield tasks. `groundTruthCallers` = the call sites that MUST be updated (the "missed call-site" denominator). 5 positive + 2 negative controls (`shouldCallChainHelp: false`). |
| `verify-callgraph.mjs` | Gate: indexes the fixture with CodeSage and checks extracted `callers(X)` matches `tasks.json` ground truth. Run **before** the experiment — inaccurate context invalidates the measurement. |

## Call graph (ground truth)

```
placeOrder → checkStock, reserve, cartTotal      (order.ts → inventory.ts, pricing.ts)
cartTotal  → lineTotal                            (pricing.ts)
lineTotal  → addTax, formatMoney                  (pricing.ts → money.ts)
```

## Run the accuracy gate

```bash
# from the CodeSage repo root
npm run build
node poc/d4/verify-callgraph.mjs   # expect: all callers match ground truth, exit 0
```

## Run the experiment (P5)

`run-experiment.mjs` wires the whole A/B loop. The REAL parts run locally:
index fixture → per-task CodeSage call-chain context (direct callers/callees,
depth 1, matching `groundTruthCallers`) → two arms (control / treatment) →
metrics (missed call-sites, first-pass pass, iterations, cost) → aggregate →
pre-registered GO/NO-GO gate (decision driven by the positive-control tasks).

```bash
npm run build
node poc/d4/run-experiment.mjs        # MODE=mock smoke (default)
N=5 node poc/d4/run-experiment.mjs    # 5 runs/arm/task
```

The Builder call is behind a pluggable adapter:

- **MODE=mock** (default) — a NEUTRAL synthetic builder returning the *same*
  result for both arms. It validates the harness plumbing end-to-end and, by
  construction, yields no signal (tie → NO-GO). The numbers are synthetic and
  clearly banner-labelled; this is **not** a measurement.
- **MODE=real** — not runnable yet. Two real prerequisites:
  1. **An LLM provider key** (none configured in the dev sandbox: no
     ANTHROPIC/XAI/GROQ/OPENROUTER key, no local ollama). The real run costs
     tokens.
  2. **A brownfield-task → BuilderInput adapter.** VibeOps's Builder input is
     greenfield-pipeline-shaped (`source_agent: ui-ux`, upstream PRD/design/
     test-plan artifacts). A "modify function X, update callers" task must be
     adapted into that shape (or a different VibeOps entrypoint used) before the
     real arm can run and its patches be applied + tested against the fixture.

Negative-control tasks (`shouldCallChainHelp: false`) must show no treatment
advantage in a real run, else the signal is prompt-length noise rather than the
call chain.
