// implements DEC-140
/**
 * `egr lint` — two ways the replacement relations in a document set disagree
 * with themselves (dev-platform DEC-140 D1). No model, no graph, nothing is
 * written, and nothing is blocked: it reports.
 *
 *   1. `superseded-without-declaration` — a document whose status says it is
 *      superseded, while no document declares `supersedes: <its id>` in its
 *      front matter. The graph then still treats it as a live document.
 *   2. `live-cites-superseded` — a document whose status is live, and which
 *      cites a decision that has been superseded (a SUPERSEDES edge points at
 *      it, or its own status says superseded) through an edge that makes the
 *      decision part of the document's basis (IMPACTS or DECISION_RELATES).
 *
 * ## It reads the documents, not the graph
 *
 * The first class compares DECLARATIONS, not edges: between two specs there is
 * no SUPERSEDES edge at all (Spec → Spec is always RELATES), so comparing edges
 * would report every superseded spec. A declaration is only visible while a
 * reference still carries the field it was written under (`KnowledgeRef.via`),
 * and the graph has already forgotten that. So this runs the same parser
 * `egr index --docs` runs (`SpecDecisionKnowledgeSource`, over the same
 * documents `collectKnowledgeDocs` gathers), in memory. The second class asks
 * `edgeForRef`, the function `ingest` itself builds edges with, so "which edge
 * would this reference become" is answered in one place.
 *
 * ## A status it cannot read is not a pass
 *
 * `status` is the front-matter field, nothing else (the same value a Spec node
 * stores). A document with none cannot be judged as superseded and cannot be
 * judged as live, so it is judged as neither: it is counted as 無法判定, listed
 * in the report, and a report with any of them is never `clean`. A folder with
 * no named spec/decision document at all is `undetermined` for the same reason:
 * zero findings over zero documents is not a verdict.
 *
 * A decision that is only a stub (some document cited it, none was scanned) has
 * no status to read and is not counted as unreadable: no document was seen, so
 * nothing could have been read. It counts as superseded only when a scanned
 * document declares `supersedes` for it.
 */

import { SpecDecisionKnowledgeSource, edgeForRef, type KnowledgeRef, type ParsedKnowledgeDoc } from "./parser.js";
import type { KnowledgeDoc } from "./types.js";

/**
 * Status values that mean "this document has been replaced". Matched as a
 * prefix of the status text, case-insensitively and at a word boundary, because
 * real statuses carry a note after the word (`Superseded（DevAP 已退場…）`).
 * Deliberately small: `deprecated` is not on it, since a deprecated document
 * need not have a successor to declare.
 */
export const SUPERSEDED_STATUSES: readonly string[] = ["superseded", "replaced", "已取代", "被取代"];

export type LintRule = "superseded-without-declaration" | "live-cites-superseded";

export interface LintFinding {
  rule: LintRule;
  /** The document the finding is about, relative to the scanned directory. */
  file: string;
  /** Its artifact id. */
  id: string;
  /** Its status, verbatim. */
  status: string;
  /** Plain-language reason, naming the ids involved. */
  reason: string;
  /** `live-cites-superseded` only: the superseded decision it cites. */
  cites?: string;
  /** `live-cites-superseded` only: the edge the citation becomes. */
  edge?: "IMPACTS" | "DECISION_RELATES";
  /** `live-cites-superseded` only: why the cited decision counts as superseded. */
  supersededBecause?: Array<{ by: "SUPERSEDES edge"; from: string } | { by: "status"; status: string }>;
}

export type LintStatus = "findings" | "undetermined" | "clean";

export interface LintReport {
  /**
   * `findings`: at least one finding. `undetermined`: no finding, but the answer
   * is not "consistent" - a status could not be read, or no document was named.
   * `clean`: at least one named document, every status readable, nothing found.
   */
  status: LintStatus;
  /** Why `undetermined`, when it is. */
  undeterminedReason?: string;
  scanned: {
    /** Markdown files read. */
    documents: number;
    /** Documents that resolved to a spec/decision id and own it. */
    named: number;
    /** Documents with no spec/decision id (a README, a CHANGELOG ...). */
    unnamed: number;
    /** Documents set aside because another document owns their id. */
    setAside: number;
  };
  /** The status words read as "superseded", so the verdict can be checked against the vocabulary. */
  supersededStatuses: readonly string[];
  findings: LintFinding[];
  counts: Record<LintRule, number>;
  /** Named documents whose status could not be read: not judged, never counted as passing. */
  undeterminable: { count: number; files: string[] };
}

function statusKnown(status: string): boolean {
  const t = status.trim();
  return t !== "" && t.toLowerCase() !== "unknown";
}

function isSupersededStatus(status: string): boolean {
  const t = status.trim().toLowerCase();
  return SUPERSEDED_STATUSES.some((w) => {
    if (!t.startsWith(w)) return false;
    // A word boundary after an English word: "supersededly" is not "superseded".
    const next = t.charAt(w.length);
    return next === "" || !/[a-z0-9_]/.test(next);
  });
}

/** Lint a set of documents (the shape `egr index --docs` feeds `indexKnowledgeDocs`). */
export async function lintKnowledgeDocs(docs: readonly KnowledgeDoc[]): Promise<LintReport> {
  const source = new SpecDecisionKnowledgeSource([...docs]);
  const fragment = await source.ingest();
  const owners = source.owners;
  const byId = new Map<string, ParsedKnowledgeDoc>(owners.map((p) => [p.id, p]));

  // Every SUPERSEDES edge that exists among the scanned documents, by the decision it points at.
  const supersededFrom = new Map<string, string[]>();
  for (const e of fragment.edges) {
    if (e.label !== "SUPERSEDES") continue;
    const from = supersededFrom.get(e.to) ?? [];
    from.push(e.from);
    supersededFrom.set(e.to, from);
  }

  // Who declares `supersedes: <id>`: any owner, either kind (a spec's declaration counts for a spec).
  const declaredBy = new Map<string, string[]>();
  for (const p of owners) {
    for (const ref of p.refs) {
      if (!ref.via.includes("supersedes")) continue;
      const by = declaredBy.get(ref.id) ?? [];
      by.push(p.id);
      declaredBy.set(ref.id, by);
    }
  }

  const findings: LintFinding[] = [];
  const undeterminable: string[] = [];

  for (const p of owners) {
    if (!statusKnown(p.status)) undeterminable.push(p.path);
  }

  // Class 1: status superseded, nobody declares it.
  for (const p of owners) {
    if (!statusKnown(p.status) || !isSupersededStatus(p.status)) continue;
    if ((declaredBy.get(p.id) ?? []).length > 0) continue;
    findings.push({
      rule: "superseded-without-declaration",
      file: p.path,
      id: p.id,
      status: p.status,
      reason: `${p.id} has status "${p.status}", but no document declares \`supersedes: ${p.id}\` in its front matter, so the graph still treats it as live`,
    });
  }

  // Class 2: a live document cites a superseded decision as part of its basis.
  const supersededBecause = (d: string): NonNullable<LintFinding["supersededBecause"]> => {
    const why: NonNullable<LintFinding["supersededBecause"]> = [];
    for (const from of supersededFrom.get(d) ?? []) why.push({ by: "SUPERSEDES edge", from });
    const owner = byId.get(d);
    if (owner && owner.kind === "Decision" && statusKnown(owner.status) && isSupersededStatus(owner.status)) {
      why.push({ by: "status", status: owner.status });
    }
    return why;
  };
  for (const p of owners) {
    if (!statusKnown(p.status) || isSupersededStatus(p.status)) continue;
    const seen = new Set<string>();
    for (const ref of p.refs as readonly KnowledgeRef[]) {
      if (ref.kind !== "Decision" || seen.has(ref.id)) continue;
      const edge = edgeForRef(p, ref);
      if (edge.label !== "IMPACTS" && edge.label !== "DECISION_RELATES") continue;
      const why = supersededBecause(ref.id);
      if (why.length === 0) continue;
      seen.add(ref.id);
      const because = why
        .map((w) => (w.by === "status" ? `its status is "${w.status}"` : `${w.from} declares \`supersedes: ${ref.id}\``))
        .join(" and ");
      findings.push({
        rule: "live-cites-superseded",
        file: p.path,
        id: p.id,
        status: p.status,
        cites: ref.id,
        edge: edge.label,
        supersededBecause: why,
        reason: `${p.id} has status "${p.status}" and still cites ${ref.id} (${edge.label}), which is superseded: ${because}`,
      });
    }
  }

  findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || (a.cites ?? "").localeCompare(b.cites ?? ""));
  undeterminable.sort();

  const counts: Record<LintRule, number> = { "superseded-without-declaration": 0, "live-cites-superseded": 0 };
  for (const f of findings) counts[f.rule]++;

  const scanned = {
    documents: docs.length,
    named: owners.length,
    unnamed: source.unresolved.length,
    setAside: source.conflicts.reduce((n, c) => n + c.setAside.length, 0),
  };
  let status: LintStatus;
  let undeterminedReason: string | undefined;
  if (findings.length > 0) status = "findings";
  else if (owners.length === 0) {
    status = "undetermined";
    undeterminedReason = `no spec/decision document was found among the ${docs.length} Markdown file(s) scanned, so there was nothing to judge`;
  } else if (undeterminable.length > 0) {
    status = "undetermined";
    undeterminedReason = `${undeterminable.length} of ${owners.length} named document(s) have no readable front-matter status and were not judged`;
  } else status = "clean";

  return {
    status,
    ...(undeterminedReason !== undefined ? { undeterminedReason } : {}),
    scanned,
    supersededStatuses: SUPERSEDED_STATUSES,
    findings,
    counts,
    undeterminable: { count: undeterminable.length, files: undeterminable },
  };
}

/** The human-readable report. Always says the denominator and what it could not judge. */
export function formatLint(r: LintReport, dir: string): string {
  const s = r.scanned;
  const lines: string[] = [
    `lint: ${s.documents} Markdown file(s) in ${dir}: ${s.named} named spec/decision document(s), ${s.unnamed} without an id` +
      `${s.setAside ? `, ${s.setAside} set aside (duplicate id)` : ""}`,
    `status read as superseded: ${r.supersededStatuses.join(" | ")} (front-matter \`status\` only)`,
  ];
  for (const f of r.findings) lines.push(`  [${f.rule}] ${f.file} - ${f.reason}`);
  lines.push(
    `findings: ${r.findings.length} (${r.counts["superseded-without-declaration"]} superseded-without-declaration, ${r.counts["live-cites-superseded"]} live-cites-superseded)`,
  );
  if (r.undeterminable.count > 0) {
    const shown = r.undeterminable.files.slice(0, 5).join(", ");
    lines.push(
      `無法判定 (cannot determine): ${r.undeterminable.count} document(s) have no readable front-matter status; not judged, not counted as passing` +
        `${shown ? ` (e.g. ${shown}${r.undeterminable.count > 5 ? ", ..." : ""}; --json lists all)` : ""}`,
    );
  } else {
    lines.push("無法判定 (cannot determine): 0");
  }
  lines.push(
    r.status === "findings"
      ? "result: findings (reported, nothing is blocked; exit 0)"
      : r.status === "clean"
        ? "result: clean"
        : `result: undetermined - ${r.undeterminedReason ?? "not a pass"}`,
  );
  return lines.join("\n");
}
