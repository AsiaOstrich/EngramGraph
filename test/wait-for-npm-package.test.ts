import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/wait-for-npm-package.sh — what release-compat-check.yml waits on before it installs a published
 * engramgraph on four platforms (dev-platform #307).
 *
 * 0.16.0: the old wait asked `npm view <spec> version`, which the registry answers BEFORE it serves the
 * package file. The wait passed, `npm install` got a 404 for engramgraph-0.16.0.tgz, and all four platforms
 * went red having tested nothing (run 44994199862). The wait must end only when the file itself downloads,
 * and a wait that runs out must say "NO platform was tested", not "a platform is broken".
 *
 * The script is run for real; only `npm`, `curl` and `sleep` are fakes placed in front of PATH.
 * `npm view <spec> version` and `npm view <spec> dist.tarball` are answered separately, which is the
 * whole point: "the version is listed" and "the file is there" are two facts.
 */

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts", "wait-for-npm-package.sh");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface World {
  /** The registry lists this version (`npm view <spec> version` answers). */
  listed: boolean;
  /** HEAD on the tarball answers 2xx from this attempt on (1 = always, Infinity = never). */
  fileFromAttempt: number;
}

interface Result {
  status: number | null;
  output: string; // $GITHUB_OUTPUT
  text: string; // stdout + stderr
  npmCalls: string[]; // each `npm view` field asked about
  headRequests: string[]; // each URL curl was asked about
}

function run(spec: string, world: World, env: Record<string, string> = {}): Result {
  const dir = mkdtempSync(join(tmpdir(), "egr-wait-npm-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const npmLog = join(dir, "npm.log");
  const curlLog = join(dir, "curl.log");
  const counter = join(dir, "attempt");
  const outFile = join(dir, "github_output");
  writeFileSync(outFile, "");
  writeFileSync(counter, "0");
  // `npm view <spec> <field>`: `version` -> a version, `dist.tarball` -> the tarball URL; nothing at all when not listed.
  writeFileSync(
    join(dir, "npm"),
    `#!/bin/sh
echo "$3" >> "${npmLog}"
if [ "${world.listed}" != "true" ]; then exit 1; fi
if [ "$3" = "dist.tarball" ]; then echo "https://registry.example/$2.tgz"; else echo 1.2.3; fi
`,
  );
  // curl: counts the attempts that reach it; succeeds from `fileFromAttempt` on, and records what it was asked about.
  writeFileSync(
    join(dir, "curl"),
    `#!/bin/sh
for a in "$@"; do U="$a"; done
echo "$U" >> "${curlLog}"
N=$(( $(cat "${counter}") + 1 )); echo $N > "${counter}"
if [ "$N" -ge ${world.fileFromAttempt === Infinity ? 999999 : world.fileFromAttempt} ]; then exit 0; fi
exit 22
`,
  );
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
  for (const f of ["npm", "curl", "sleep"]) chmodSync(join(dir, f), 0o755);

  const r = spawnSync("bash", [SCRIPT, spec], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: outFile, ...env },
  });
  const lines = (f: string): string[] => {
    try {
      return readFileSync(f, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { status: r.status, output: readFileSync(outFile, "utf8"), text: `${r.stdout}\n${r.stderr}`, npmCalls: lines(npmLog), headRequests: lines(curlLog) };
}

describe("scripts/wait-for-npm-package.sh (dev-platform #307)", () => {
  it("succeeds when the version is listed AND its package file downloads, and hands the spec on", () => {
    const r = run("engramgraph@0.17.0", { listed: true, fileFromAttempt: 1 });
    expect(r.status).toBe(0);
    expect(r.output).toBe("package-spec=engramgraph@0.17.0\n");
    // It asked the registry for the file's URL and then asked THAT URL — the thing `npm install` will fetch.
    expect(r.npmCalls).toEqual(["dist.tarball"]);
    expect(r.headRequests).toEqual(["https://registry.example/engramgraph@0.17.0.tgz"]);
  });

  it("version listed but package file 404: fails saying NO platform was tested, hands nothing to the matrix [dev-platform #307]", () => {
    const r = run("engramgraph@0.16.0", { listed: true, fileFromAttempt: Infinity }, { WAIT_ATTEMPTS: "4", WAIT_INTERVAL: "0" });
    expect(r.status).toBe(1);
    expect(r.output).toBe(""); // the matrix is not started on a package that cannot be installed
    expect(r.text).toContain("NO platform was tested");
    expect(r.text).toContain("UNVERIFIED");
    // ...and it names the real cause, so a reader does not go looking at a platform.
    expect(r.text).toContain("does not download yet");
    expect(r.headRequests).toHaveLength(4);
  });

  it("keeps waiting while the file is late, and succeeds on the attempt it appears", () => {
    const r = run("engramgraph@0.17.0", { listed: true, fileFromAttempt: 3 }, { WAIT_ATTEMPTS: "5", WAIT_INTERVAL: "0" });
    expect(r.status).toBe(0);
    expect(r.output).toBe("package-spec=engramgraph@0.17.0\n");
    expect(r.headRequests).toHaveLength(3);
  });

  it("a version the registry never lists: fails saying NO platform was tested, never touches curl", () => {
    const r = run("engramgraph@9.9.9", { listed: false, fileFromAttempt: 1 }, { WAIT_ATTEMPTS: "3", WAIT_INTERVAL: "0" });
    expect(r.status).toBe(1);
    expect(r.output).toBe("");
    expect(r.text).toContain("NO platform was tested");
    expect(r.text).toContain("does not list");
    expect(r.headRequests).toEqual([]);
  });

  it("refuses to run without a spec", () => {
    const r = run("", { listed: true, fileFromAttempt: 1 });
    expect(r.status).toBe(2);
    expect(r.output).toBe("");
  });
});
