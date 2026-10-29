import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEgr, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * `egr refs check` takes the list of indexed roots from the graph's parse-health
 * manifest. When the manifest file is THERE but cannot be read (cut off, not
 * JSON, the wrong shape), it used to take that as "no roots" and carry on: in a
 * multi-root graph a reference into another root then comes out `missing`, with
 * nothing on screen or in the exit status to say the list it was judged against
 * was never read.
 *
 * A graph with no manifest file at all is the ordinary single-repo case and must
 * stay quiet. Every case here runs the built CLI as a command against a real
 * indexed graph and reads back stdout, stderr and the exit status.
 */

let built: BuiltEgr;
let work: string;
let dbPath: string;
let manifestPath: string;
let intactManifest: string;
let note: string;

function egr(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [built.cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ENGRAM_DB: dbPath },
    cwd: work,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-refs-manifest-"));
  dbPath = join(work, "graph.db");
  manifestPath = join(work, "graph.parse-manifest.json");
  const proj = join(work, "proj");
  mkdirSync(join(proj, "docs"), { recursive: true });
  writeFileSync(join(proj, "a.ts"), "export function alpha() { return beta(); }\nexport function beta() { return 1; }\n");
  note = join(proj, "docs", "note.md");
  writeFileSync(note, "See `a.ts` and `beta` for the details.\n");
  const r = egr(["index", proj]);
  if (r.status !== 0) throw new Error(`fixture index failed: ${r.stderr}`);
  if (!existsSync(manifestPath)) throw new Error(`fixture has no manifest at ${manifestPath}`);
  intactManifest = readFileSync(manifestPath, "utf8");
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

/** Put the manifest in a known state before each run, so no case depends on another. */
function setManifest(content: string | null): void {
  if (content === null) rmSync(manifestPath, { force: true });
  else writeFileSync(manifestPath, content);
}

describe("egr refs check with a manifest it cannot read", () => {
  it.each([
    ["cut off in the middle", () => intactManifest.slice(0, Math.floor(intactManifest.length / 2))],
    ["not JSON at all", () => "this is not json {"],
    ["valid JSON of the wrong shape", () => "{}"],
  ])("manifest %s: says INCOMPLETE in the report and on stderr, and exits 1 although every reference is present", (_name, damaged) => {
    setManifest(damaged());
    const r = egr(["refs", "check", note]);
    expect(r.stdout, r.stderr).toContain("INCOMPLETE");
    expect(r.stdout).toContain(manifestPath);
    // The references themselves are fine; the only reason for a non-zero status is the unread list.
    expect(r.stdout).toMatch(/\[present\] path `a\.ts`/);
    expect(r.stdout).not.toContain("[missing]");
    expect(r.stderr).toContain("INCOMPLETE");
    expect(r.status).toBe(1);
  });

  it("--json: stdout is still the JSON alone, carrying incompleteReasons; the exit status and stderr say it too", () => {
    setManifest("this is not json {");
    const r = egr(["refs", "check", note, "--json"]);
    const parsed = JSON.parse(r.stdout) as { items: unknown[]; incompleteReasons?: string[] };
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.incompleteReasons).toHaveLength(1);
    expect(parsed.incompleteReasons?.[0]).toContain(manifestPath);
    expect(r.stderr).toContain("INCOMPLETE");
    expect(r.status).toBe(1);
  });

  it("a graph with NO manifest file is the ordinary single-repo case: no warning, exit 0", () => {
    setManifest(null);
    const r = egr(["refs", "check", note]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toContain("INCOMPLETE");
    expect(r.stderr).not.toContain("INCOMPLETE");
    expect(r.stdout).toMatch(/\[present\] path `a\.ts`/);
    const json = JSON.parse(egr(["refs", "check", note, "--json"]).stdout) as { incompleteReasons?: string[] };
    expect(json.incompleteReasons).toBeUndefined();
  });

  it("an intact manifest: no warning, exit 0", () => {
    setManifest(intactManifest);
    const r = egr(["refs", "check", note]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toContain("INCOMPLETE");
    expect(r.stderr).not.toContain("INCOMPLETE");
  });
});
