import { describe, it, expect } from "vitest";

import { extractCodeGraph, extractProject } from "../src/code-graph/extractor.js";
import { cmdDoctor } from "../src/cli/run.js";

// XSPEC-414 R4: every command (a project function call OR an external
// program) parses to the same generic `command` node — the "only project
// functions become CALLS" filter is the engine's EXISTING cross-file
// bare-name resolver, not anything bash-specific. See queries/bash.ts's
// module doc comment.

describe("CodeGraph extractor — Bash (XSPEC-414 R4)", () => {
  it("extracts a Function node for a function definition, and a CALLS edge for a call to another project function", () => {
    const src = `
log_msg() {
  echo "hi"
}
main() {
  log_msg
}
`;
    const { nodes, edges } = extractCodeGraph(src, { filePath: "main.sh" });
    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    expect(functionIds).toEqual(["main.sh#log_msg", "main.sh#main"]);

    const callsFromMain = edges
      .filter((e) => e.label === "CALLS" && e.from === "main.sh#main")
      .map((e) => e.to);
    expect(callsFromMain).toEqual(["main.sh#log_msg"]);
  });

  it("stamps every Function node with provider: tree-sitter", () => {
    const src = "log_msg() {\n  echo hi\n}\n";
    const { nodes } = extractCodeGraph(src, { filePath: "lib.sh" });
    for (const n of nodes.filter((n) => n.label === "Function")) {
      expect(n.properties.provider).toBe("tree-sitter");
    }
  });

  it("accepts the alternate `function name { ... }` definition spelling", () => {
    const src = "function log_msg {\n  echo hi\n}\n";
    const { nodes } = extractCodeGraph(src, { filePath: "lib.sh" });
    expect(nodes.filter((n) => n.label === "Function").map((n) => n.id)).toEqual(["lib.sh#log_msg"]);
  });

  it("infers the bash language from the .sh/.bash extensions without an explicit language override", () => {
    for (const ext of [".sh", ".bash"]) {
      const src = "f() { g; }\ng() { :; }\n";
      const { edges } = extractCodeGraph(src, { filePath: `x${ext}` });
      expect(edges.filter((e) => e.label === "CALLS")).toHaveLength(1);
    }
  });
});

describe("XSPEC-414 R4 AC-4 — external commands never become CALLS or nodes", () => {
  it("Scenario: lib.sh defines log(), main.sh sources it and calls log and grep — a CALLS edge to log, no grep node at all", () => {
    const files = [
      { path: "lib.sh", source: 'log() {\n  echo "$1"\n}\n' },
      {
        path: "main.sh",
        source: "source lib.sh\nmain() {\n  log \"starting\"\n  grep foo bar\n}\n",
      },
    ];
    const { fragment, calls } = extractProject(files);

    // A CALLS edge to log() exists...
    expect(calls).toBe(1);
    const callEdge = fragment.edges.find((e) => e.label === "CALLS");
    expect(callEdge).toMatchObject({ from: "main.sh#main", to: "lib.sh#log" });

    // ...and grep produces NO node anywhere in the graph — not merely no
    // edge, no node at all (Function nodes only ever come from
    // @definition.function captures, never from a call site).
    const grepNode = fragment.nodes.find((n) => "name" in n.properties && n.properties.name === "grep");
    expect(grepNode).toBeUndefined();
  });

  it("a call to an external command with no project-defined function of that name is silently unresolved, not an error", () => {
    const files = [{ path: "main.sh", source: 'main() {\n  echo "hi"\n  ls -la\n}\n' }];
    const result = extractProject(files);
    expect(result.calls).toBe(0);
    expect(result.unresolved).toBeGreaterThanOrEqual(2); // echo, ls
  });
});

describe("XSPEC-414 R4 — module relationships: source / .", () => {
  it("resolves `source lib.sh` into a Module -> Module IMPORTS edge", () => {
    const { fragment, imports } = extractProject([
      { path: "lib.sh", source: "log() { :; }\n" },
      { path: "main.sh", source: "source lib.sh\nmain() { log; }\n" },
    ]);
    expect(imports).toBe(1);
    const importEdge = fragment.edges.find((e) => e.label === "IMPORTS");
    expect(importEdge).toMatchObject({ from: "main.sh", to: "lib.sh", fromLabel: "Module", toLabel: "Module" });
  });

  it("resolves the dot-form `. lib.sh` the same way", () => {
    const { fragment, imports } = extractProject([
      { path: "lib.sh", source: "log() { :; }\n" },
      { path: "main.sh", source: ". lib.sh\nmain() { log; }\n" },
    ]);
    expect(imports).toBe(1);
    const importEdge = fragment.edges.find((e) => e.label === "IMPORTS");
    expect(importEdge).toMatchObject({ from: "main.sh", to: "lib.sh" });
  });

  it("resolves a subdirectory source relative to the sourcing file's own directory", () => {
    const { fragment, imports } = extractProject([
      { path: "lib/util.sh", source: "log() { :; }\n" },
      { path: "bin/main.sh", source: "source ../lib/util.sh\nmain() { log; }\n" },
    ]);
    expect(imports).toBe(1);
    const importEdge = fragment.edges.find((e) => e.label === "IMPORTS");
    expect(importEdge).toMatchObject({ from: "bin/main.sh", to: "lib/util.sh" });
  });

  it("does not create an IMPORTS edge for `source` of a file outside the indexed batch", () => {
    const { fragment, imports } = extractProject([
      { path: "main.sh", source: "source /etc/profile\nmain() { :; }\n" },
    ]);
    expect(imports).toBe(0);
    expect(fragment.edges.filter((e) => e.label === "IMPORTS")).toEqual([]);
  });
});

describe("egr doctor lists Bash (XSPEC-414 R4)", () => {
  it("includes Bash among the reported languages", () => {
    const result = cmdDoctor("/tmp/probe-bash/.engram/graph.db");
    const bash = result.languages.find((l) => l.language === "bash");
    expect(bash).toBeDefined();
    expect(bash?.label).toBe("Bash");
  });
});
