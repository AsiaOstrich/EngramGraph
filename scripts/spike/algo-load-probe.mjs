// Spike: does a locally built ALGO extension load from an arbitrary path on this OS?
// Two arms. The control arm must FAIL at page_rank, or the experiment proves nothing
// (the function could be built in, or auto-loaded from a cache somewhere).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(process.cwd(), "noop.js"));
const ryu = require("ryugraph");
const { Database, Connection } = ryu;

const extPath = process.argv[2];
const results = {};

async function arm(name, loadPath) {
  const dir = mkdtempSync(join(tmpdir(), `algo-${name}-`));
  const conn = new Connection(new Database(join(dir, "g.db")));
  const step = async (label, cypher) => {
    try {
      const r = await conn.query(cypher);
      const rows = r && typeof r.getAll === "function" ? await r.getAll() : [];
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e).split("\n")[0] };
    }
  };
  await step("schema", "CREATE NODE TABLE N(id STRING, PRIMARY KEY(id)); CREATE REL TABLE E(FROM N TO N);");
  await step("data", "CREATE (:N {id:'a'})-[:E]->(:N {id:'b'});");
  const load = loadPath ? await step("load", `LOAD EXTENSION '${loadPath}';`) : null;
  await step("project", "CALL project_graph('pg', ['N'], ['E']);");
  const rank = await step("page_rank", "CALL page_rank('pg') RETURN node.id, rank;");
  results[name] = { loadPath, load, pageRank: rank };
}

await arm("control", null);
await arm("backslash", extPath);
await arm("forwardslash", extPath.replace(/\\/g, "/"));
console.log(JSON.stringify(results, null, 2));

const controlFailed = results.control.pageRank.ok === false;
const anyLoaded = results.backslash.pageRank.ok || results.forwardslash.pageRank.ok;
console.log(`control failed as required: ${controlFailed}`);
console.log(`experiment page_rank worked (backslash / forwardslash): ${results.backslash.pageRank.ok} / ${results.forwardslash.pageRank.ok}`);
process.exit(controlFailed && anyLoaded ? 0 : 1);
