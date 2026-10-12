// implements XSPEC-476
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildEgr, REPO_ROOT, type BuiltEgr } from "./helpers/build-cli.js";

/**
 * XSPEC-476 R5 — three small things the 0.13.0-beta.3 Windows consumer report found.
 *
 *   (a) MCP `serverInfo.version` said 0.1.0 whatever the package version was.
 *   (b) `egr communities` had no `--limit` (1.3 MB of JSON on a real project).
 *   (c) `egr refs check` ran git once per reference (12 files, 75 s).
 *
 * Each test drives the built CLI or the built MCP stdio server as a child
 * process — the entry points a user has — and reads what comes back.
 */

let built: BuiltEgr;
let work: string;

beforeAll(() => {
  built = buildEgr();
  work = mkdtempSync(join(tmpdir(), "egr-476-r5-"));
}, 120_000);

afterAll(() => {
  built?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("XSPEC-476 R5a: MCP serverInfo.version", () => {
  it("the stdio server reports the package version in its initialize answer, not a constant [xspec476-r5a-mcp-version]", async () => {
    const pkgVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [built.mcp],
        env: { ...process.env, ENGRAM_DB: join(work, "r5a.db") } as Record<string, string>,
        stderr: "ignore",
      }),
    );
    try {
      const info = client.getServerVersion();
      expect(info?.name).toBe("engramgraph");
      expect(info?.version).toBe(pkgVersion);
      expect(info?.version).not.toBe("0.1.0");
    } finally {
      await client.close();
    }
  });
});
