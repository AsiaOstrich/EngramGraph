import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * engramgraph depends on the security repack `@asiaostrich/ryugraph`, not on
 * upstream `ryugraph@25.9.1`, whose `cmake-js ^7.3.0` range pulls tar 6
 * (critical in `npm audit`). See README "Dependency vulnerability warnings".
 *
 * The repack is declared as an npm alias so the install path and every
 * `import ... from "ryugraph"` are unchanged. That is also why nothing else in
 * the suite would notice a revert to upstream: every other test passes against
 * either package. These checks are the ones that go red.
 *
 * The consumer-side proof (no tar/cmake-js advisory in what users install) is
 * `npm run audit:ship`, the release gate; it needs network and minutes, so it
 * is not repeated here.
 */

const ROOT = join(__dirname, "..");
const FORK = "@asiaostrich/ryugraph";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  overrides?: Record<string, string>;
  allowScripts?: Record<string, boolean>;
};
// Read off disk: ryugraph's `exports` map blocks require("ryugraph/package.json").
const installed = JSON.parse(
  readFileSync(join(ROOT, "node_modules", "ryugraph", "package.json"), "utf8"),
) as { name: string; version: string; dependencies: Record<string, string> };

const spec = pkg.dependencies.ryugraph ?? "";
const match = /^npm:(@asiaostrich\/ryugraph)@(\d+\.\d+\.\d+-asiaostrich\.\d+)$/.exec(spec);

describe("ryugraph resolves to the security repack", () => {
  it("package.json aliases ryugraph to an exact @asiaostrich/ryugraph version", () => {
    expect(match, `"ryugraph": "${spec}" is not an exact alias to ${FORK}`).not.toBeNull();
  });

  it("what is installed at node_modules/ryugraph is the repack, at the declared version", () => {
    expect(installed.name).toBe(FORK);
    expect(installed.version).toBe(match?.[2]);
  });

  it("the installed engine declares cmake-js 8, so tar 6 is out of the tree without any override", () => {
    expect(installed.dependencies["cmake-js"]).toMatch(/^\^8\./);
    // The old workaround only ever cleaned this repo's own tree. Keeping it would
    // let this repo stay clean even if the repack's range regressed.
    expect(pkg.overrides?.["cmake-js"]).toBeUndefined();
    const cmakeJs = JSON.parse(
      readFileSync(join(ROOT, "node_modules", "cmake-js", "package.json"), "utf8"),
    ) as { version: string };
    expect(cmakeJs.version.split(".")[0]).toBe("8");
  });

  it("allowScripts approves the repack's install script under the key npm uses (real name@version)", () => {
    // npm >= 11 keys allowScripts by the package's own name even when it is
    // installed under an alias; without this, install.js never copies the
    // prebuilt engine into place and require("ryugraph") fails.
    expect(pkg.allowScripts?.[`${FORK}@${match?.[2]}`]).toBe(true);
    expect(pkg.allowScripts?.["ryugraph@25.9.1"]).toBeUndefined();
  });

  it("the tar acceptance is gone, so the release gate fails if tar comes back", () => {
    const accepted = JSON.parse(
      readFileSync(join(ROOT, "security", "accepted-advisories.json"), "utf8"),
    ) as { accepted: Array<{ package: string }> };
    expect(accepted.accepted.map((a) => a.package)).not.toContain("tar");
    expect(accepted.accepted.map((a) => a.package)).not.toContain("cmake-js");
  });
});
