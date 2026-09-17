// Spike: with extension.ryugraph.io unreachable, does `INSTALL ALGO; LOAD EXTENSION ALGO;`
// succeed when the file sits in ryugraph's cache path — and fail when it does not?
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(join(process.cwd(), "noop.js"));
const { Database, Connection } = require("ryugraph");
const label = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), `algo-cache-${label}-`));
const conn = new Connection(new Database(join(dir, "g.db")));
async function step(cypher) {
  try { const r = await conn.query(cypher); return { ok: true, rows: r && typeof r.getAll === "function" ? await r.getAll() : [] }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e).split("\n")[0] }; }
}
await step("CREATE NODE TABLE N(id STRING, PRIMARY KEY(id)); CREATE REL TABLE E(FROM N TO N);");
await step("CREATE (:N {id:'a'})-[:E]->(:N {id:'b'});");
const install = await step("INSTALL ALGO;");
const load = await step("LOAD EXTENSION ALGO;");
await step("CALL project_graph('pg', ['N'], ['E']);");
const rank = await step("CALL page_rank('pg') RETURN node.id, rank;");
console.log(JSON.stringify({ label, install, load, rank }, null, 2));
console.log(`RESULT ${label}: install=${install.ok} page_rank=${rank.ok}`);
