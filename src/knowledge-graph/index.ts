export {
  SpecDecisionKnowledgeSource,
  parseKnowledgeDoc,
  indexKnowledgeDocs,
} from "./parser.js";
export type { ParsedKnowledgeDoc, KnowledgeIndexResult, DocIdConflict, ReplacedDocument, KnowledgeConflict, DocIdSource } from "./parser.js";
export { lintKnowledgeDocs, formatLint, SUPERSEDED_STATUSES } from "./lint.js";
export type { LintReport, LintFinding, LintRule, LintStatus } from "./lint.js";
export { classifyRef, classifyLeadingRef } from "./linker.js";
export type { ClassifiedRef } from "./linker.js";
export { impactAnalysis } from "./query.js";
export type {
  KnowledgeDoc,
  KnowledgeNodeKind,
  ImpactNode,
  ImpactAnalysisResult,
} from "./types.js";
