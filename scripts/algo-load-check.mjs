#!/usr/bin/env node
// implements XSPEC-416 R2
/**
 * Does this extension file load on this machine, by path, with nothing downloaded?
 *
 *   node scripts/algo-load-check.mjs <libalgo.ryu_extension>
 *
 * Two arms. The control arm (no extension loaded) must FAIL at page_rank — otherwise
 * a passing experiment proves nothing, because the function could be built in or
 * picked up from a cache. The experiment loads the file the way engramgraph does:
 * a forward-slash path in a double-quoted statement (backslashes are a parser error
 * on Windows; single quotes break on an apostrophe — both measured).
 * Run with ryugraph resolvable from the current directory.
 */
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/algo-load-check.mjs <libalgo.ryu_extension>");
  process.exit(2);
}
const require = createRequire(join(process.cwd(), "noop.js"));
const { Database, Connection } = require("ryugraph");

async function arm(name, loadPath) {
  const conn = new Connection(new Database(join(mkdtempSync(join(tmpdir(), `algo-${name}-`)), "g.db")));
  const run = async (cypher) => {
    try {
      const r = await conn.query(cypher);
      return { ok: true, rows: r && typeof r.getAll === "function" ? await r.getAll() : [] };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e).split("\n")[0] };
    }
  };
  await run("CREATE NODE TABLE N(id STRING, PRIMARY KEY(id)); CREATE REL TABLE E(FROM N TO N);");
  await run("CREATE (:N {id:'a'})-[:E]->(:N {id:'b'});");
  if (loadPath) {
    const p = loadPath.replace(/\\/g, "/");
    const load = await run(`LOAD EXTENSION "${p.replace(/"/g, '\\"')}";`);
    if (!load.ok) return { load, rank: { ok: false, error: "not attempted" } };
  }
  await run("CALL project_graph('pg', ['N'], ['E']);");
  return { rank: await run("CALL page_rank('pg') RETURN node.id, rank;") };
}

const control = await arm("control", null);
const experiment = await arm("experiment", file);
console.log(JSON.stringify({ control, experiment }, null, 2));
const controlFailed = control.rank.ok === false;
const loaded = experiment.rank.ok === true && (experiment.rank.rows?.length ?? 0) === 2;
console.log(`control failed as required: ${controlFailed}; extension loaded and ranked 2 nodes: ${loaded}`);
process.exit(controlFailed && loaded ? 0 : 1);
