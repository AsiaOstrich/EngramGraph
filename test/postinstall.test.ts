import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NOTICE, shouldShowNotice } from "../postinstall.js";

/**
 * The post-install MCP notice. // implements XSPEC-365 R7
 *
 * Two things are worth asserting here, and the second matters more than the
 * first: *what* it says, and *when it stays quiet*. A banner that leaks into
 * every CI build of every project that depends on this package is a worse
 * outcome than not having the notice at all, and it is the kind of thing that
 * is only noticed by other people, in other repositories, after release.
 */

const ROOT = join(__dirname, "..");

describe("post-install MCP notice", () => {
  describe("when it shows", () => {
    it("shows on a global install", () => {
      expect(shouldShowNotice({ npm_config_global: "true" })).toBe(true);
    });

    it("stays quiet when the package is a dependency of another project", () => {
      // Measured, not assumed: npm leaves npm_config_global unset for a
      // dependency install and sets it to "true" for `npm install -g`.
      expect(shouldShowNotice({})).toBe(false);
      expect(shouldShowNotice({ npm_config_global: undefined })).toBe(false);
      expect(shouldShowNotice({ npm_config_global: "false" })).toBe(false);
    });
  });

  describe("what it says", () => {
    it("gives the exact command, not a description of it", () => {
      expect(NOTICE).toContain("claude mcp add egr -- npx egr-mcp");
    });

    it("says how to confirm it worked", () => {
      // Without this the reader has no way to tell a successful registration
      // from a silently broken one — the same failure shape this whole spec
      // exists to stop shipping.
      expect(NOTICE).toContain("claude mcp list");
    });

    it("explains why registration isn't automatic", () => {
      // Otherwise the obvious reading is "this installer is lazy" rather than
      // "a package writing itself into your assistant's tool config would be
      // granting itself tool access".
      expect(NOTICE).toMatch(/not registered automatically/i);
    });

    it("points non-Claude clients at the full docs", () => {
      expect(NOTICE).toContain("docs/MCP.md");
      expect(NOTICE).toMatch(/Codex|Cursor|Windsurf/);
    });

    it("mentions the CLI too, so the MCP isn't mistaken for the only path", () => {
      expect(NOTICE).toContain("egr index");
    });
  });

  describe("wiring", () => {
    it("is registered as the postinstall hook and shipped in the tarball", () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        files: string[];
        scripts: Record<string, string>;
      };
      expect(pkg.scripts.postinstall).toBe("node postinstall.js");
      expect(pkg.files).toContain("postinstall.js");
    });

    it("prints nothing when run as a hook outside a global install", () => {
      // The real hook path, not the predicate: run the actual file the way npm
      // runs it, with the environment a dependency install would give it.
      const out = execFileSync(process.execPath, [join(ROOT, "postinstall.js")], {
        encoding: "utf8",
        env: { ...process.env, npm_config_global: undefined },
      });
      expect(out.trim()).toBe("");
    });

    it("prints the notice when run as a hook during a global install", () => {
      // Control for the assertion above: if this also printed nothing, the
      // test above would be passing for the wrong reason.
      const out = execFileSync(process.execPath, [join(ROOT, "postinstall.js")], {
        encoding: "utf8",
        env: { ...process.env, npm_config_global: "true" },
      });
      expect(out).toContain("claude mcp add egr -- npx egr-mcp");
    });
  });
});
