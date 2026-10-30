// implements XSPEC-508
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * Issue #18 — on Windows an `egr-mcp` that was started before an upgrade keeps serving the OLD
 * version, and nothing says so. docs/MCP.md tells the user how to see it: the server reports its
 * own version in the `initialize` answer and in the `doctor` tool, so it can be compared with
 * `egr --version`. This pins that claim: the built stdio server, started as a client starts it,
 * answers with the package version in both places. (The suggestion in the issue to ADD such a
 * report is therefore not needed; only the docs were missing.)
 */

let built: BuiltEgr;
let work: string;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-i18-"));
}, 120_000);

afterAll(() => {
  built?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("issue #18: a running egr-mcp reports the version it is running", () => {
  it("initialize.serverInfo.version and the doctor tool's egrVersion both equal the package version", async () => {
    const pkgVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
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
      expect(client.getServerVersion()?.version).toBe(pkgVersion);
      const res = (await client.callTool({ name: "doctor", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0]!.text) as { egrVersion?: string };
      expect(body.egrVersion).toBe(pkgVersion);
    } finally {
      await client.close();
    }
  });
});
