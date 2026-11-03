import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { checkServerVersion, readInstalledVersion } from "../src/mcp/installed-version.js";
import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * Issue #18 — an `egr-mcp` that was started before `npm i -g engramgraph@<newer>` keeps serving
 * the OLD version and nothing says so. The server now compares the version it started with to the
 * `package.json` that is installed NOW, on every `doctor` call, and says so in `doctor`'s `server`
 * field. (`serverInfo.version` and `egrVersion` already reported the running version; what was
 * missing was the comparison, so that a user does not have to notice a difference by eye.)
 *
 * These tests start the built stdio server the way an MCP client does and call the `doctor` tool.
 * The "installed package" is simulated the way an upgrade changes it: a `package.json` named
 * `engramgraph` in the package root of the running bundle (the built directory), which is rewritten
 * while the server runs. The server is not told anything: it finds the file by walking up from where
 * its code sits, as it does in a real install (`<pkg>/dist/mcp/stdio.js` → `<pkg>/package.json`).
 */

let built: BuiltEgr;
let work: string;
let pkgJson: string; // the simulated package root's package.json, beside the built bundle
let runningVersion: string;

interface ServerField {
  runningVersion: string;
  installedVersion: string | null;
  status: "current" | "stale" | "unknown";
  message: string;
}
interface DoctorBody {
  egrVersion: string;
  languages: unknown[];
  server: ServerField;
}

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-i18b-"));
  pkgJson = join(REPO_ROOT, built.distRel, "package.json");
  runningVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
}, 120_000);

afterAll(() => {
  built?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
});

const install = (version: string) => writeFileSync(pkgJson, JSON.stringify({ name: "engramgraph", version, type: "module" }));

async function withServer<T>(fn: (doctor: () => Promise<DoctorBody>) => Promise<T>): Promise<T> {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [built.mcp],
      env: { ...process.env, ENGRAM_DB: join(work, "g.db") } as Record<string, string>,
      stderr: "ignore",
    }),
  );
  try {
    return await fn(async () => {
      const res = (await client.callTool({ name: "doctor", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError).toBeFalsy();
      return JSON.parse(res.content[0]!.text) as DoctorBody;
    });
  } finally {
    await client.close();
  }
}

describe("issue #18: a running egr-mcp says when it is not the installed version", () => {
  it("doctor says the server is stale, naming both versions and what to do, when the installed version differs", async () => {
    install("99.0.0-installed");
    await withServer(async (doctor) => {
      const body = await doctor();
      expect(body.server.status).toBe("stale");
      expect(body.server.runningVersion).toBe(runningVersion);
      expect(body.server.installedVersion).toBe("99.0.0-installed");
      expect(body.server.message).toContain(`running version ${runningVersion}`);
      expect(body.server.message).toContain("version 99.0.0-installed is installed");
      expect(body.server.message).toMatch(/restart the MCP client/);
      // the rest of doctor still answers
      expect(body.egrVersion).toBe(runningVersion);
      expect(body.languages.length).toBeGreaterThan(0);
    });
  });

  it("doctor says the server is current when the installed version is the one it runs (control)", async () => {
    install(runningVersion);
    await withServer(async (doctor) => {
      const body = await doctor();
      expect(body.server.status).toBe("current");
      expect(body.server.installedVersion).toBe(runningVersion);
      expect(body.server.message).not.toMatch(/restart/);
    });
  });

  it("doctor says it cannot determine, and does not say current, when the installed version cannot be read", async () => {
    // Damaged AFTER the server started (a package.json that is bad at start-up stops Node itself
    // from loading the bundle), as it would be mid-write while npm replaces the package.
    install(runningVersion);
    await withServer(async (doctor) => {
      writeFileSync(pkgJson, "{ this is not json");
      const body = await doctor();
      expect(body.server.status).toBe("unknown");
      expect(body.server.installedVersion).toBeNull();
      expect(body.server.runningVersion).toBe(runningVersion);
      expect(body.server.message).toMatch(/^cannot determine/);
      expect(body.server.message).toContain("could not be read");
      expect(body.server.message).toContain("egr --version");
    });
  });

  it("the comparison is made again on every call: an upgrade while the same server keeps running turns current into stale", async () => {
    install(runningVersion);
    await withServer(async (doctor) => {
      expect((await doctor()).server.status).toBe("current");
      install("99.1.0-upgraded-while-running");
      const after = await doctor();
      expect(after.server.status).toBe("stale");
      expect(after.server.installedVersion).toBe("99.1.0-upgraded-while-running");
    });
  });
});

describe("issue #18: reading the installed version", () => {
  const roots: string[] = [];
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "egr-i18c-"));
    roots.push(d);
    return d;
  };
  afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("finds the engramgraph package.json above the start directory, passing over one with another name", () => {
    const root = fresh();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "engramgraph", version: "1.2.3" }));
    const nested = join(root, "dist", "mcp");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "dist", "package.json"), JSON.stringify({ name: "something-else", version: "9.9.9" }));
    expect(readInstalledVersion(nested)).toEqual({ version: "1.2.3" });
    expect(checkServerVersion("1.2.3", nested).status).toBe("current");
    expect(checkServerVersion("1.2.2", nested)).toMatchObject({ status: "stale", installedVersion: "1.2.3" });
  });

  it("is a problem, not a version, when the engramgraph package.json has no version or is not an object", () => {
    const noVersion = fresh();
    writeFileSync(join(noVersion, "package.json"), JSON.stringify({ name: "engramgraph" }));
    const notObject = fresh();
    writeFileSync(join(notObject, "package.json"), "[1,2]");
    expect(readInstalledVersion(noVersion)).toMatchObject({ problem: expect.stringContaining("has no version") });
    expect(readInstalledVersion(notObject)).toMatchObject({ problem: expect.stringContaining("not a package.json object") });
    expect(checkServerVersion("1.0.0", noVersion).status).toBe("unknown");
  });

  it("reports unknown, not stale or current, when the walk reaches the filesystem root without finding the package", () => {
    // "/" has no package.json named engramgraph; use the root itself as the start directory.
    const r = readInstalledVersion(process.platform === "win32" ? "C:\\" : "/");
    expect(r).toMatchObject({ problem: expect.stringContaining("no engramgraph package.json found") });
  });

  it("the default start directory is the real package: the in-process server reads this repository's version as installed", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    expect(checkServerVersion(pkg.version)).toMatchObject({ status: "current", installedVersion: pkg.version });
  });
});
