// XSPEC-237 dogfood: index real dev-platform XSPEC/DEC corpus into CodeSage
// KnowledgeGraph and run impact-analysis. Pure graph, no LLM.
import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { GraphConnection, initSchema, indexKnowledgeDocs, impactAnalysis } from "../dist/index.js";
const ROOT = process.argv[2] ?? "../dev-platform/cross-project";
const docs = [];
for (const sub of ["specs","decisions","adr"]) {
  let files = []; try { files = readdirSync(join(ROOT,sub)); } catch { continue; }
  for (const f of files) if (f.endsWith(".md"))
    docs.push({ content: readFileSync(join(ROOT,sub,f),"utf8"), fallbackId: f });
}
const dbDir = join(tmpdir(),"codesage-dogfood"); rmSync(dbDir,{recursive:true,force:true}); mkdirSync(dbDir,{recursive:true});
const conn = GraphConnection.open(join(dbDir,"graph.db")); await initSchema(conn);
const res = await indexKnowledgeDocs(conn, docs);
const q = async (c)=> (await conn.query(c));
const cnt = async (c)=> Number((await q(c))[0]?.c ?? 0);
console.log(`\n=== indexed ${docs.length} docs ===`);
console.log(`Spec nodes: ${await cnt("MATCH (s:Spec) RETURN count(s) AS c")}, Decision nodes: ${await cnt("MATCH (d:Decision) RETURN count(d) AS c")}`);
console.log(`IMPACTS edges: ${await cnt("MATCH ()-[r:IMPACTS]->() RETURN count(r) AS c")}, SUPERSEDES edges: ${await cnt("MATCH ()-[r:SUPERSEDES]->() RETURN count(r) AS c")}`);
console.log(`(fragment: specs=${res.specs}, decisions=${res.decisions}, impacts=${res.impacts}, supersedes=${res.supersedes})`);
// how many specs/decisions have ANY edge vs isolated
const connectedSpecs = await cnt("MATCH (d:Decision)-[:IMPACTS]->(s:Spec) RETURN count(DISTINCT s) AS c");
console.log(`\nSpecs with ≥1 IMPACTS edge: ${connectedSpecs} / ${await cnt("MATCH (s:Spec) RETURN count(s) AS c")} (rest isolated)`);
// top impacted specs
console.log("\n=== top impacted specs (most decisions) ===");
for (const r of await q("MATCH (d:Decision)-[:IMPACTS]->(s:Spec) RETURN s.id AS id, count(d) AS n ORDER BY n DESC LIMIT 8"))
  console.log(`  ${r.id}: ${r.n} decision(s)`);
// real query
console.log("\n=== impactAnalysis(XSPEC-237) ===");
console.log(JSON.stringify(await impactAnalysis(conn,"XSPEC-237",3)));
console.log("\n=== impactAnalysis(XSPEC-240) ===");
console.log(JSON.stringify(await impactAnalysis(conn,"XSPEC-240",3)));
process.exit(0);
