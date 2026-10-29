import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `release-compat-check.yml` is the only thing that installs a PUBLISHED
 * engramgraph on Windows / macOS / old glibc. It used to start on
 * `release: published` — the same event as publish.yml — and out-wait the
 * publish with a timeout. publish.yml outgrew the timeout (11m50s against a
 * 10-minute poll), so v0.13.1 and v0.14.0-beta.2 were never platform-tested:
 * "Package never reached npm", every matrix job skipped.
 *
 * Two kinds of check, because a workflow cannot be run here:
 *   1. the file's wiring: it starts after publish.yml has COMPLETED, only
 *      proceeds when that completion was a success, still has the manual
 *      entry point;
 *   2. the "which version" shell step is extracted from the file and run for
 *      real, with a fake `npm`, so what it asks the registry about is read
 *      back rather than inferred from its text.
 */

const ROOT = join(__dirname, "..");
const COMPAT = readFileSync(join(ROOT, ".github/workflows/release-compat-check.yml"), "utf8");
const PUBLISH = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8");

/** Non-comment lines only: a mention in a comment is not a trigger. */
const code = (text: string) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

/** Lines of a top-level key (`on:`, `jobs:`) or of a job (`  name:`) up to the next sibling. */
function block(text: string, header: string, indent: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === header);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.trim() !== "" && !l.trim().startsWith("#") && l.length - l.trimStart().length <= indent) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const triggers = code(block(COMPAT, "on:", 0));

describe("release-compat-check.yml starts after the publish, not beside it", () => {
  it("is triggered by publish.yml COMPLETING (workflow_run), not by the release event", () => {
    expect(triggers, "no `on:` block").not.toBe("");
    expect(triggers).toMatch(/^\s{2}workflow_run:/m);
    expect(triggers).toMatch(/types:\s*\[completed\]/);
    // The race: any release trigger puts this workflow and publish.yml on the same clock again.
    expect(triggers).not.toMatch(/^\s{2}release:/m);
    expect(code(COMPAT)).not.toContain("release: published");
  });

  it("names the workflow it follows by the `name:` publish.yml actually has", () => {
    const publishName = /^name:\s*(.+)$/m.exec(PUBLISH)?.[1]?.trim();
    expect(publishName).toBeTruthy();
    const followed = /workflows:\s*\[\s*"([^"]+)"\s*\]/.exec(triggers)?.[1];
    expect(followed, "workflow_run has no workflows: [...] entry").toBeTruthy();
    expect(followed).toBe(publishName);
  });

  it("keeps the manual entry point, with the version input", () => {
    expect(triggers).toMatch(/^\s{2}workflow_dispatch:/m);
    expect(triggers).toMatch(/^\s{6}version:/m);
  });

  it("lets the check proceed only when the publish run succeeded", () => {
    const resolve = code(block(COMPAT, "  resolve-version:", 2));
    expect(resolve, "no resolve-version job").not.toBe("");
    const cond = /^\s{4}if:\s*(.+)$/m.exec(resolve)?.[1] ?? "";
    expect(cond).toContain("github.event.workflow_run.conclusion == 'success'");
    // A manual run has no workflow_run payload, so it must not be blocked by that condition.
    expect(cond).toContain("github.event_name != 'workflow_run'");
  });

  it("says why nothing was tested when the publish did not succeed, instead of reporting 'never reached npm'", () => {
    const job = code(block(COMPAT, "  publish-not-succeeded:", 2));
    expect(job, "no job explains a failed publish").not.toBe("");
    expect(job).toMatch(/if:.*workflow_run\.conclusion != 'success'/);
    expect(job).toContain("::warning");
    expect(job).toContain("UNVERIFIED");
    // The registry-poll message must not be what a failed publish produces.
    expect(job).not.toContain("npm view");
  });

  it("takes the version from the publish run's tag and never from `latest` on that path", () => {
    const step = code(COMPAT);
    expect(step).toContain("github.event.workflow_run.head_branch");
    expect(step).not.toContain("github.event.release.tag_name");
  });
});

// --- run the version-resolution step for real ----------------------------

/** The `run: |` body of the step with `id: resolve`. */
function resolveScript(): string {
  const lines = COMPAT.split("\n");
  const id = lines.findIndex((l) => l.trim() === "id: resolve");
  expect(id, "no step with id: resolve").toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > id && l.trim() === "run: |");
  expect(run).toBeGreaterThan(-1);
  const out: string[] = [];
  for (let i = run + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.trim() !== "" && l.length - l.trimStart().length < 10) break;
    out.push(l.slice(10));
  }
  return out.join("\n");
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Run {
  status: number | null;
  output: string; // what the step wrote to $GITHUB_OUTPUT
  asked: string[]; // each spec the step asked `npm view` about
  stdout: string;
}

/** Run the step with a fake `npm view` that answers for `published` specs only, and a fake `sleep`. */
function runResolve(env: Record<string, string>, published: string[]): Run {
  const dir = mkdtempSync(join(tmpdir(), "egr-compat-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const asked = join(dir, "asked.log");
  const outFile = join(dir, "github_output");
  writeFileSync(outFile, "");
  writeFileSync(
    join(dir, "npm"),
    `#!/bin/sh\necho "$2" >> "${asked}"\ncase " ${published.join(" ")} " in *" $2 "*) echo 1.0.0; exit 0;; esac\nexit 1\n`,
  );
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "npm"), 0o755);
  chmodSync(join(dir, "sleep"), 0o755);
  writeFileSync(join(dir, "step.sh"), resolveScript());
  const r = spawnSync("bash", [join(dir, "step.sh")], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: outFile, INPUT_VERSION: "", EVENT_NAME: "", PUBLISHED_REF: "", ...env },
  });
  const askedLog = (() => {
    try {
      return readFileSync(asked, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  })();
  return { status: r.status, output: readFileSync(outFile, "utf8"), asked: askedLog, stdout: `${r.stdout}\n${r.stderr}` };
}

describe("release-compat-check.yml resolve step, run for real", () => {
  it("after a publish run, tests exactly the version of the tag that run shipped", () => {
    const r = runResolve({ EVENT_NAME: "workflow_run", PUBLISHED_REF: "v0.14.0-beta.3" }, ["engramgraph@0.14.0-beta.3"]);
    expect(r.status).toBe(0);
    expect(r.output).toContain("package-spec=engramgraph@0.14.0-beta.3");
    // Asked about that version and nothing else — `latest` would be a different package after a beta.
    expect(r.asked).toEqual(["engramgraph@0.14.0-beta.3"]);
  });

  it("refuses a publish run whose ref is not a version tag, and does not fall back to latest", () => {
    const r = runResolve({ EVENT_NAME: "workflow_run", PUBLISHED_REF: "main" }, ["engramgraph@latest"]);
    expect(r.status).toBe(1);
    expect(r.output).toBe("");
    expect(r.asked).toEqual([]);
    expect(r.stdout).toContain("Cannot tell which version publish.yml shipped");
  });

  it("a manual run with a version tests that version", () => {
    const r = runResolve({ EVENT_NAME: "workflow_dispatch", INPUT_VERSION: "0.13.1" }, ["engramgraph@0.13.1"]);
    expect(r.status).toBe(0);
    expect(r.output).toContain("package-spec=engramgraph@0.13.1");
  });

  it("a manual run without a version tests latest (the documented default)", () => {
    const r = runResolve({ EVENT_NAME: "workflow_dispatch" }, ["engramgraph@latest"]);
    expect(r.status).toBe(0);
    expect(r.output).toContain("package-spec=engramgraph@latest");
  });

  it("when the published version never shows up, fails saying NO platform was tested", () => {
    const r = runResolve({ EVENT_NAME: "workflow_run", PUBLISHED_REF: "v9.9.9" }, []);
    expect(r.status).toBe(1);
    expect(r.output).toBe("");
    expect(r.asked).toHaveLength(20);
    expect(r.stdout).toContain("NO platform was tested");
  });
});
