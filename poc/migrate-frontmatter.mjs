/**
 * XSPEC-237 Phase 5 — derive relationship front-matter for existing XSPEC/DEC docs.
 *
 * The real corpus declares relationships in inconsistent metadata lines
 * (`> **關聯規格**: XSPEC-237`, `- **相關**:` + bullets, `取代`/supersedes,
 * `depends_on`). This conservatively extracts XSPEC/SPEC/DEC/ADR tokens from
 * those *labelled* lines only and writes them as the standard's relationship
 * front-matter (related / impacts / impacted_by / supersedes), which the
 * upgraded CodeSage parser now reads.
 *
 * Default is DRY-RUN (reports only). Pass --apply to write front-matter.
 * Idempotent: skips a doc that already has a `---` front-matter block.
 *
 *   node poc/migrate-frontmatter.mjs ../dev-platform/cross-project          # dry-run
 *   node poc/migrate-frontmatter.mjs ../dev-platform/cross-project --apply  # write
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? "../dev-platform/cross-project";
const APPLY = process.argv.includes("--apply");

const ID_RE = /\b(XSPEC|SPEC|DEC|ADR)-\d+/gi;
const LABEL_RE = /(相關|關聯規格|關聯|depends_on|影響|取代|supersed|related|impacts|impacted_by)/i;
const SUPERSEDE_RE = /(取代|supersed)/i;

const kindOf = (id) => (/^(XSPEC|SPEC)/i.test(id) ? "Spec" : "Decision");

/** Extract relationship sets from a doc's top metadata region. */
function extract(content, selfId) {
  const lines = content.split(/\r?\n/);
  // metadata region: until the first "## " section, capped at 40 lines
  let end = lines.findIndex((l) => /^##\s/.test(l));
  end = end === -1 ? Math.min(lines.length, 40) : Math.min(end, 40);

  const docKind = kindOf(selfId);
  const out = { related: new Set(), impacts: new Set(), impacted_by: new Set(), supersedes: new Set() };

  for (let i = 0; i < end; i++) {
    if (!LABEL_RE.test(lines[i])) continue;
    const isSupersede = SUPERSEDE_RE.test(lines[i]);
    // gather this line + following continuation (bullets / indented) lines
    let block = lines[i];
    let j = i + 1;
    while (j < end && /^(\s+\S|\s*[-*]\s)/.test(lines[j]) && !LABEL_RE.test(lines[j])) {
      block += `\n${lines[j]}`;
      j++;
    }
    for (const m of block.matchAll(ID_RE)) {
      const id = m[0].toUpperCase();
      if (id === selfId) continue;
      const tokKind = kindOf(id);
      if (docKind === "Decision") {
        if (isSupersede && tokKind === "Decision") out.supersedes.add(id);
        else if (tokKind === "Spec") out.impacts.add(id);
        else out.related.add(id);
      } else {
        if (tokKind === "Decision") out.impacted_by.add(id);
        else out.related.add(id);
      }
    }
    i = j - 1;
  }
  return out;
}

function selfIdFromName(name) {
  const m = name.match(/\b(XSPEC|SPEC|DEC|ADR)-\d+/i);
  return m ? m[0].toUpperCase() : null;
}

function fmLine(field, set) {
  const ids = [...set].filter(Boolean).sort();
  return ids.length ? `${field}: [${ids.join(", ")}]` : null;
}

let docs = 0, changed = 0, edges = 0, skippedFm = 0;
const samples = [];

for (const sub of ["specs", "decisions", "adr"]) {
  let files = [];
  try { files = readdirSync(join(ROOT, sub)); } catch { continue; }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const selfId = selfIdFromName(f);
    if (!selfId) continue;
    docs++;
    const path = join(ROOT, sub, f);
    const content = readFileSync(path, "utf8");
    if (/^---\r?\n/.test(content)) { skippedFm++; continue; } // already has front-matter

    const rel = extract(content, selfId);
    const fmLines = [
      fmLine("related", rel.related),
      fmLine("impacts", rel.impacts),
      fmLine("impacted_by", rel.impacted_by),
      fmLine("supersedes", rel.supersedes),
    ].filter(Boolean);
    if (!fmLines.length) continue;

    changed++;
    const count = rel.related.size + rel.impacts.size + rel.impacted_by.size + rel.supersedes.size;
    edges += count;
    if (samples.length < 12) samples.push(`${selfId}: ${fmLines.join("  ")}`);

    if (APPLY) {
      const fm = `---\nid: ${selfId}\n${fmLines.join("\n")}\n---\n`;
      writeFileSync(path, fm + content);
    }
  }
}

console.log(`\n=== ${APPLY ? "APPLIED" : "DRY-RUN"} — relationship front-matter ===`);
console.log(`docs scanned: ${docs}, already had front-matter (skipped): ${skippedFm}`);
console.log(`docs that ${APPLY ? "got" : "would get"} relationship front-matter: ${changed}`);
console.log(`total relationship tokens extracted: ${edges}\n`);
console.log("sample:");
for (const s of samples) console.log(`  ${s}`);
