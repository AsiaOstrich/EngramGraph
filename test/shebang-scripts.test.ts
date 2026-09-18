/**
 * Extension-less shebang scripts (XSPEC-414 R4 OQ2).
 *
 * "GIVEN 無副檔名、shebang 為 bash/sh（含 `/usr/bin/env bash` 形式）的腳本
 * WHEN `egr index` THEN 該檔案要被索引，走 Bash 語法。" R1's walk already reads
 * the first 8000 bytes of every unmatched file to decide if it's binary; this
 * reuses that SAME read to also check for a Bash/sh shebang, rather than
 * opening the file a second time.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkFiles } from "../src/cli/walk.js";
import { CODE_EXTS, cmdIndex } from "../src/cli/run.js";
import { GraphConnection } from "../src/graph-db/connection.js";
import { initSchema } from "../src/graph-db/schema.js";

describe("walkFiles: extension-less shebang scripts (XSPEC-414 R4 OQ2)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-shebang-"));
    writeFileSync(join(dir, "deploy"), "#!/bin/bash\necho deploying\n");
    chmodSync(join(dir, "deploy"), 0o755);
    writeFileSync(join(dir, "provision"), "#!/usr/bin/env bash\necho provisioning\n");
    writeFileSync(join(dir, "check"), "#!/usr/bin/env sh\necho checking\n");
    writeFileSync(join(dir, "posix-sh"), "#!/bin/sh\necho posix\n");
    // A shebang naming an interpreter OUTSIDE this spec's scope (Python) —
    // stays unindexed, not silently guessed as Bash.
    writeFileSync(join(dir, "generate"), "#!/usr/bin/env python3\nprint('hi')\n");
    // No shebang at all — an ordinary extension-less text file.
    writeFileSync(join(dir, "Makefile"), "all:\n\techo hi\n");
    // A real, extensioned .sh file — control group, must be collected the
    // ordinary way regardless of shebang detection.
    writeFileSync(join(dir, "real.sh"), "#!/bin/bash\necho real\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("collects a #!/bin/bash extension-less script as language: bash when detectShebangScripts is on", () => {
    const { files } = walkFiles(dir, CODE_EXTS, { detectShebangScripts: true });
    const deploy = files.find((f) => f.path === "deploy");
    expect(deploy?.language).toBe("bash");
  });

  it("collects #!/usr/bin/env bash the same way", () => {
    const { files } = walkFiles(dir, CODE_EXTS, { detectShebangScripts: true });
    expect(files.find((f) => f.path === "provision")?.language).toBe("bash");
  });

  it("collects #!/usr/bin/env sh and #!/bin/sh as bash too (OQ2: sh counts as bash)", () => {
    const { files } = walkFiles(dir, CODE_EXTS, { detectShebangScripts: true });
    expect(files.find((f) => f.path === "check")?.language).toBe("bash");
    expect(files.find((f) => f.path === "posix-sh")?.language).toBe("bash");
  });

  it("does NOT collect a python shebang — out of this spec's scope, stays unindexed", () => {
    const { files, unindexed } = walkFiles(dir, CODE_EXTS, { detectShebangScripts: true });
    expect(files.some((f) => f.path === "generate")).toBe(false);
    expect(unindexed.some((f) => f.path === "generate" && f.ext === "(none)")).toBe(true);
  });

  it("an ordinary extension-less non-shebang file stays unindexed under (none)", () => {
    const { unindexed } = walkFiles(dir, CODE_EXTS, { detectShebangScripts: true });
    expect(unindexed.some((f) => f.path === "Makefile" && f.ext === "(none)")).toBe(true);
  });

  it("a real .sh file is collected the ordinary extension-matched way, with no explicit `language` override", () => {
    const { files } = walkFiles(dir, CODE_EXTS, { detectShebangScripts: true });
    const real = files.find((f) => f.path === "real.sh");
    expect(real).toBeDefined();
    expect(real?.language).toBeUndefined();
  });

  it("detectShebangScripts defaults to off: the same bash shebang script is NOT collected without opting in", () => {
    // This is the docs-walk safety net (`cmdIndex`'s `walkFiles(dir, [".md"])`
    // call never passes the flag) — verified here at the `walkFiles` level
    // directly, without needing to spin up a docs-indexing run.
    const { files, unindexed } = walkFiles(dir, CODE_EXTS);
    expect(files.some((f) => f.path === "deploy")).toBe(false);
    expect(unindexed.some((f) => f.path === "deploy" && f.ext === "(none)")).toBe(true);
  });
});

describe("cmdIndex: a shebang script becomes a real Bash Function node (XSPEC-414 R4 OQ2)", () => {
  it("indexes an extension-less bash script end-to-end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-shebang-cmdindex-"));
    try {
      const src = join(dir, "repo");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "deploy"), "#!/bin/bash\ndeploy_app() {\n  echo deploying\n}\ndeploy_app\n");
      const conn = GraphConnection.open(join(dir, "graph.db"));
      await initSchema(conn);
      const r = await cmdIndex(conn, { dir: src });
      // Counted as an indexed file (not unindexed) with a real Function node.
      expect(r.code.files).toBe(1);
      expect(r.code.functions).toBeGreaterThanOrEqual(1);
      expect(r.unindexedCode.count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
