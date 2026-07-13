export { extractCodeGraph, extractProject } from "./extractor.js";
export type { Extraction, ProjectExtraction, RawCall } from "./extractor.js";
export { indexFile, indexProject } from "./indexer.js";
export { callers, callees, callChain, implementers, implementedSpecs } from "./query.js";
export type {
  CallDirection,
  CallNode,
  CallChainResult,
  ImplementerModule,
  ImplementersResult,
  ImplementedSpec,
  ImplementedSpecsResult,
} from "./query.js";
export type {
  ExtractOptions,
  IndexResult,
  ProjectFile,
  ProjectIndexResult,
  SupportedLanguage,
} from "./types.js";
