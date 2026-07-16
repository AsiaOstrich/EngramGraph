import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NODE_TABLE_DDL, REL_TABLE_DDL } from "../src/graph-db/schema.js";
import { parseDeclaredColumns } from "../src/graph-db/schema-migration.js";

/**
 * Ties two human-written docs to the source of truth they summarize, so
 * either one silently drifting fails CI instead of sitting undiscovered.
 *
 * 2026-07-16: an audit (prompted by "what other docs need the same
 * locale-sync check as README.md") found docs/API.md's DDL summary (and both
 * its zh-TW/zh-CN copies) had drifted from the real schema.ts — missing the
 * `provider` column on `Function`/`Class` (added by XSPEC-333 R1, `ccd4974`),
 * still showing `IMPLEMENTS(Function → Spec)` instead of the current
 * `IMPLEMENTS(Module → Spec)` (changed by XSPEC-331 R1), and missing the
 * `RELATES(Spec → Spec)` table entirely (added by XSPEC-331 R1/R2).
 * docs/MCP.md's tool table was separately missing 3 of the 8 real MCP tools
 * (`implementers`/`implemented_specs`/`related`) in all three languages.
 * scripts/hooks/pre-commit's header-COUNT heuristic could not have caught
 * either: no section was added or removed, existing lines just went stale.
 * This test catches that class of drift directly, by parsing the real DDL
 * constants / tool registrations and diffing them against what the docs
 * claim — not a cross-locale comparison, a doc-vs-code one.
 */

const ROOT = join(__dirname, "..");

interface DocNodeTable {
  readonly table: string;
  readonly columns: string[];
}
interface DocRelTable {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly columns: string[];
}

/** Parse the `### Schema (DDL)` fenced block in a docs/API.md-shaped file into its NODE/REL lines. */
function parseApiDocDdl(mdPath: string): { nodes: DocNodeTable[]; rels: DocRelTable[] } {
  const text = readFileSync(mdPath, "utf8");
  // Anchor on the "Schema (DDL)" heading first — the file has an earlier,
  // unrelated ` ```ts ` import-example fence, so a bare first-match-wins
  // fence regex over the whole file grabs the wrong block (or the wrong
  // span between two unrelated fences' boundaries).
  const heading = /#+\s*Schema\s*[（(]DDL[）)]/.exec(text);
  if (!heading) throw new Error(`${mdPath}: could not find a "Schema (DDL)" heading`);
  const afterHeading = text.slice(heading.index + heading[0].length);
  const fence = /```\n([\s\S]*?)\n```/.exec(afterHeading);
  if (!fence) throw new Error(`${mdPath}: could not find the DDL fenced code block after the Schema (DDL) heading`);
  const body = fence[1]!;

  const nodes: DocNodeTable[] = [];
  const rels: DocRelTable[] = [];

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const nodeMatch = /^NODE\s+(\w+)\(([^)]*)\)/.exec(line);
    if (nodeMatch) {
      const table = nodeMatch[1]!;
      const columns = nodeMatch[2]!
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      nodes.push({ table, columns });
      continue;
    }

    const relMatch = /^REL\s+(\w+)\(([^)]*)\)/.exec(line);
    if (relMatch) {
      const table = relMatch[1]!;
      const parts = relMatch[2]!
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      const endpoint = parts[0]!;
      const arrowMatch = /^(\w+)\s*→\s*(\w+)$/.exec(endpoint);
      if (!arrowMatch) {
        throw new Error(`${mdPath}: REL ${table}'s first field "${endpoint}" is not a "From → To" endpoint`);
      }
      rels.push({ table, from: arrowMatch[1]!, to: arrowMatch[2]!, columns: parts.slice(1) });
      continue;
    }

    throw new Error(`${mdPath}: unrecognised DDL summary line: "${line}"`);
  }

  return { nodes, rels };
}

/** The real schema, in the same shape `parseApiDocDdl` produces, for direct comparison. */
function realSchema(): { nodes: DocNodeTable[]; rels: DocRelTable[] } {
  const nodes = NODE_TABLE_DDL.map((ddl) => {
    const { table, columns } = parseDeclaredColumns(ddl);
    return { table, columns: columns.map((c) => c.name) };
  });
  const rels = REL_TABLE_DDL.map((ddl) => {
    const { table, columns } = parseDeclaredColumns(ddl);
    const endpoint = /FROM\s+(\w+)\s+TO\s+(\w+)/.exec(ddl);
    if (!endpoint) throw new Error(`schema.ts: REL ${table}'s DDL has no "FROM x TO y" clause: ${ddl}`);
    return { table, from: endpoint[1]!, to: endpoint[2]!, columns: columns.map((c) => c.name) };
  });
  return { nodes, rels };
}

const API_DOC_PATHS = ["docs/API.md", "locales/zh-TW/docs/API.md", "locales/zh-CN/docs/API.md"];

describe("docs/API.md DDL summary stays in sync with schema.ts", () => {
  const real = realSchema();

  for (const relPath of API_DOC_PATHS) {
    describe(relPath, () => {
      const doc = parseApiDocDdl(join(ROOT, relPath));

      it("declares exactly the same NODE tables (by name)", () => {
        expect(doc.nodes.map((n) => n.table).sort()).toEqual(real.nodes.map((n) => n.table).sort());
      });

      it("declares exactly the same REL tables (by name)", () => {
        expect(doc.rels.map((r) => r.table).sort()).toEqual(real.rels.map((r) => r.table).sort());
      });

      for (const realNode of real.nodes) {
        it(`NODE ${realNode.table} has the same columns as schema.ts`, () => {
          const docNode = doc.nodes.find((n) => n.table === realNode.table);
          expect(docNode, `docs is missing NODE ${realNode.table} entirely`).toBeDefined();
          expect([...docNode!.columns].sort()).toEqual([...realNode.columns].sort());
        });
      }

      for (const realRel of real.rels) {
        it(`REL ${realRel.table} has the same endpoints + columns as schema.ts`, () => {
          const docRel = doc.rels.find((r) => r.table === realRel.table);
          expect(docRel, `docs is missing REL ${realRel.table} entirely`).toBeDefined();
          expect(docRel!.from).toBe(realRel.from);
          expect(docRel!.to).toBe(realRel.to);
          expect([...docRel!.columns].sort()).toEqual([...realRel.columns].sort());
        });
      }
    });
  }
});

const MCP_DOC_PATHS = ["docs/MCP.md", "locales/zh-TW/docs/MCP.md", "locales/zh-CN/docs/MCP.md"];

/** Every tool name `server.registerTool("name", ...)` registers, parsed from the real source (not introspecting a live McpServer — the SDK doesn't expose a listing API, and this is simpler + just as reliable for a doc-completeness check). */
function realMcpToolNames(): string[] {
  const text = readFileSync(join(ROOT, "src/mcp/server.ts"), "utf8");
  const names = [...text.matchAll(/registerTool\(\s*\n?\s*"([a-zA-Z_]+)"/g)].map((m) => m[1]!);
  if (names.length === 0) throw new Error("src/mcp/server.ts: found zero registerTool(\"...\") calls — parser broke");
  return names;
}

describe("docs/MCP.md tool table stays in sync with src/mcp/server.ts", () => {
  const realTools = realMcpToolNames();

  for (const relPath of MCP_DOC_PATHS) {
    it(`${relPath} documents every registered tool`, () => {
      const text = readFileSync(join(ROOT, relPath), "utf8");
      for (const tool of realTools) {
        expect(text.includes(`\`${tool}\``), `${relPath} is missing a row for "${tool}"`).toBe(true);
      }
    });
  }
});
