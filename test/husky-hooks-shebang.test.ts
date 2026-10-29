import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Husky 9 runs each hook as `sh -e <file>`, so a missing shebang does not change
 * what a commit does — which is exactly why nothing noticed that `.husky/pre-commit`
 * began with a comment. It is still a file with no declared interpreter: editors
 * and shell linters guess, and a hook run directly would be handed to whatever the
 * caller's shell is. This pins the one-line convention husky's own stubs follow.
 *
 * `.husky/_` is husky's generated directory (gitignored, rebuilt by `husky`), not ours.
 */

const HUSKY_DIR = join(__dirname, "..", ".husky");

function hookFiles(): string[] {
  return readdirSync(HUSKY_DIR)
    .filter((name) => name !== "_" && statSync(join(HUSKY_DIR, name)).isFile())
    .sort();
}

describe(".husky hooks declare their interpreter", () => {
  it("the repo has at least the pre-commit hook (so the next test is not vacuous)", () => {
    expect(hookFiles()).toContain("pre-commit");
  });

  it("every hook file starts with a `#!` line naming sh", () => {
    for (const name of hookFiles()) {
      const first = readFileSync(join(HUSKY_DIR, name), "utf8").split("\n", 1)[0] ?? "";
      expect(first, `.husky/${name} first line`).toMatch(/^#!\/usr\/bin\/env sh$/);
    }
  });
});
