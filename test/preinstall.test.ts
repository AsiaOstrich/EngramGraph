import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { preflightMessage } from "../preinstall.js";
import { ALL_PLATFORMS } from "../language-support.js";

/**
 * What each platform is told at install time. // implements XSPEC-365 R1
 *
 * These assertions exist because the message renders on exactly the machines
 * where something is going wrong — which are the machines whose output nobody
 * is reading. Left untested, it would be wrong precisely when it matters and
 * right in every environment anyone looks at.
 *
 * **What they do NOT establish: that any user sees this.** They call the hook
 * directly. On a real `npm install -g engramgraph` the notice appeared zero
 * times in 242 lines of output (measured 2026-08-04) — npm suppresses
 * lifecycle-script output by default, and npm >= 11 gates those scripts behind
 * an approval prompt, so on a fresh machine it may not run at all. Every
 * assertion below was green while the feature reached nobody, because each one
 * invokes the hook the way it was written rather than the way people install.
 *
 * The channel that does reach users is `egr doctor` and the skipped-language
 * line at index time (`test/doctor.test.ts`). Do not read a pass here as
 * evidence the information got through.
 */

const ROOT = join(__dirname, "..");

describe("install preflight message", () => {
  it("says nothing on linux-x64, the one fully-prebuilt platform", () => {
    expect(preflightMessage("linux-x64")).toBeNull();
  });

  it("warns about Dart on every other platform", () => {
    for (const platform of ALL_PLATFORMS) {
      if (platform === "linux-x64") continue;
      const message = preflightMessage(platform);
      expect(message, `platform ${platform}`).not.toBeNull();
      expect(message).toContain("@vokturz/tree-sitter-dart");
      expect(message).toContain("Dart");
      expect(message, "must name the platform it is talking about").toContain(
        platform,
      );
    }
  });

  it("tells the user the failure is survivable when only grammars compile", () => {
    const message = preflightMessage("win32-x64") ?? "";
    // The single most important thing this message does: stop someone reading
    // a wall of node-gyp errors and concluding the package is broken.
    expect(message).toContain("expected, not fatal");
    expect(message).toContain("installation continues");
    expect(message).toContain("every other language still works");
  });

  it("does NOT claim survivability when a required native dep must compile", () => {
    // win32-arm64 has no prebuilt ryugraph, and ryugraph is not optional —
    // promising graceful degradation there would be a lie that costs the
    // reader an hour.
    const message = preflightMessage("win32-arm64") ?? "";
    expect(message).toContain("ryugraph");
    expect(message).toContain("required, not optional");
    expect(message).not.toContain("expected, not fatal");
  });

  it("points at documentation that exists", () => {
    const message = preflightMessage("win32-x64") ?? "";
    const anchor = /#([a-z0-9-]+)\s*$/m.exec(message.trim());
    expect(anchor, "message should end with a docs link carrying an anchor").not.toBeNull();

    // A link to a heading that isn't there sends people nowhere. Derive the
    // anchor GitHub would generate from each README heading and require a hit.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const anchors = [...readme.matchAll(/^#{2,4} (.+)$/gm)].map(([, heading]) =>
      (heading ?? "")
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-"),
    );
    expect(anchors).toContain(anchor?.[1]);
  });

  it("never throws for any known platform", () => {
    for (const platform of ALL_PLATFORMS) {
      expect(() => preflightMessage(platform), platform).not.toThrow();
    }
    // An unknown platform must degrade to "everything compiles here" rather
    // than crashing the install hook.
    expect(() => preflightMessage("sunos-mips")).not.toThrow();
  });

  it("is listed in package.json files and wired as the preinstall hook", () => {
    // The hook is useless if it isn't shipped. `files` omitting it would make
    // this whole requirement a no-op for every installed copy, while every
    // test here still passed — the failure would be invisible from inside the
    // repo.
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { files: string[]; scripts: Record<string, string> };
    expect(pkg.scripts.preinstall).toBe("node preinstall.js");
    expect(pkg.files).toContain("preinstall.js");
    expect(pkg.files).toContain("language-support.js");
  });
});
