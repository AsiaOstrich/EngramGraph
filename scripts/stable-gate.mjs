#!/usr/bin/env node
// implements XSPEC-498 R2
/**
 * May this STABLE version be published? Only if the exact content has already
 * been through the Windows checklist as a preview.
 *
 *     node scripts/stable-gate.mjs <version> [--repo <git dir>] [--github-repo <owner/name>]
 *
 * WHY THIS EXISTS
 * 0.13.0 was published on 2026-10-22 after the Windows verification
 * (.github/workflows/windows-release-verify.yml) had last run against
 * 0.13.0-beta.5 on 2026-10-13. Between the two sat 121 changed files outside
 * the release bookkeeping (a fix to Windows backslash paths in .scip files
 * among them). The verification workflow is a manual `workflow_dispatch`; nothing
 * connected "it was verified" to "this is what is being published". This script
 * is that connection, and publish.yml runs it before `npm publish`.
 *
 * WHAT IT CHECKS (stable versions only: X.Y.Z)
 *   1. SAME CONTENT. The newest preview tag of the same X.Y.Z that is reachable
 *      from HEAD (vX.Y.Z-alpha.N < -beta.N < -rc.N) is compared with HEAD. The
 *      only files that may differ are the three a release commit touches, and
 *      for the two JSON ones only their version fields:
 *          package.json, package-lock.json, CHANGELOG.md
 *      Evidence for that list: the release commits v0.12.0-rc.5 (2f046e2),
 *      v0.12.0 (5ffd460), v0.13.0-beta.5 (2761117) and v0.13.0 (00fc8f4) each
 *      change exactly those three files and no fourth.
 *   2. A WINDOWS RUN THAT PASSED ON THAT PREVIEW. GitHub's run listing does not
 *      carry `workflow_dispatch` inputs, and `head_sha` is the branch tip at
 *      dispatch time, not the content that was tested. What does identify the
 *      tested version is the artifact the workflow uploads:
 *      `windows-release-verify-<exact npm version>`, named after the "Resolve
 *      the exact version under test" step (a dist-tag like `next` is already
 *      resolved by then). So the gate looks for that artifact by name and then
 *      requires its run to be: this workflow file, `workflow_dispatch`, branch
 *      `main`, completed, conclusion `success`.
 *      The conclusion check is not optional: the artifact upload is
 *      `if: always()`, so a FAILED run uploads one too (run 37818731887
 *      uploaded windows-release-verify-0.13.0-beta.1 and failed).
 *   Both checks are always evaluated and all reasons are printed.
 *
 * "COULD NOT FIND OUT" IS A REFUSAL. If the GitHub query fails, or returns
 * nothing usable, the answer is "not verified", never "fine".
 *
 * Preview versions (X.Y.Z-alpha|beta|rc.N) are not managed: exit 0 with a line
 * saying so. A version of any other shape is refused, because publish.yml's
 * dist-tag step would send it to `latest`.
 *
 * Exit codes: 0 allowed (or not managed), 1 refused, 2 usage error.
 *
 * Injection point for tests: STABLE_GATE_GH names the executable used instead
 * of `gh` (called as `<exe> api <path>`; prints JSON). In CI it is plain `gh`
 * authenticated by GH_TOKEN.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Files a release commit may change between a preview and its stable version. */
export const ALLOWED_FILES = new Set(["package.json", "package-lock.json", "CHANGELOG.md"]);

/** For these, only the version fields may differ (everything else must match). */
const VERSION_ONLY_JSON = new Set(["package.json", "package-lock.json"]);

export const VERIFY_WORKFLOW_PATH = ".github/workflows/windows-release-verify.yml";
export const VERIFY_ARTIFACT_PREFIX = "windows-release-verify-";
const VERIFY_BRANCH = "main";
const MAX_LISTED = 30; // a 121-file diff must not bury the other reason in the log

const STABLE_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const PREVIEW_RE = /^(\d+)\.(\d+)\.(\d+)-(alpha|beta|rc)\.(\d+)$/;
const PRE_ORDER = { alpha: 0, beta: 1, rc: 2 };

/** @returns {"stable" | "preview" | "unknown"} */
export function classifyVersion(version) {
  if (STABLE_RE.test(version)) return "stable";
  if (PREVIEW_RE.test(version)) return "preview";
  return "unknown";
}

/** Negative / zero / positive, ordering preview versions of one X.Y.Z. */
export function comparePreview(a, b) {
  const ma = PREVIEW_RE.exec(a);
  const mb = PREVIEW_RE.exec(b);
  if (!ma || !mb) throw new Error(`not preview versions: ${a}, ${b}`);
  const byKind = PRE_ORDER[ma[4]] - PRE_ORDER[mb[4]];
  return byKind !== 0 ? byKind : Number(ma[5]) - Number(mb[5]);
}

/** The newest preview version (no leading v) among tag names for this stable version, or null. */
export function pickLatestPreview(stable, tagNames) {
  const m = STABLE_RE.exec(stable);
  if (!m) return null;
  const candidates = [];
  for (const tag of tagNames) {
    if (!tag.startsWith("v")) continue;
    const v = tag.slice(1);
    const p = PREVIEW_RE.exec(v);
    if (p && p[1] === m[1] && p[2] === m[2] && p[3] === m[3]) candidates.push(v);
  }
  candidates.sort(comparePreview);
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/** JSON with keys sorted, so two files that differ only in key order compare equal. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

/** The file's JSON with its version fields blanked: package.json `version`; package-lock.json `version` and `packages[""].version`. */
export function withoutVersionFields(file, text) {
  const doc = JSON.parse(text);
  if (doc && typeof doc === "object") {
    if ("version" in doc) doc.version = null;
    if (file === "package-lock.json" && doc.packages && doc.packages[""] && "version" in doc.packages[""]) {
      doc.packages[""].version = null;
    }
  }
  return JSON.stringify(canonical(doc));
}

let localEnvVars;
/** Environment for git with every variable git itself exports to a hook removed (GIT_DIR, GIT_INDEX_FILE, ...). */
function gitEnv() {
  if (!localEnvVars) {
    localEnvVars = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const env = { ...process.env };
  for (const name of localEnvVars) delete env[name];
  return env;
}

function git(repo, args, { allowFail = false } = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  }
  return r.stdout;
}

/**
 * Files whose content differs between the preview tag and HEAD beyond what a
 * release commit may change. Returns [{ file, why }].
 */
export function disallowedDifferences(repo, previewTag) {
  const names = git(repo, ["diff", "--name-only", "--no-renames", "-z", `refs/tags/${previewTag}`, "HEAD"])
    .split("\0")
    .filter(Boolean);
  const out = [];
  for (const file of names) {
    if (!ALLOWED_FILES.has(file)) {
      out.push({ file, why: "changed since the preview" });
      continue;
    }
    if (!VERSION_ONLY_JSON.has(file)) continue; // CHANGELOG.md: the release record, any change is expected
    const before = git(repo, ["show", `refs/tags/${previewTag}:${file}`], { allowFail: true });
    const after = git(repo, ["show", `HEAD:${file}`], { allowFail: true });
    if (before === null || after === null) {
      out.push({ file, why: before === null ? "added since the preview" : "deleted since the preview" });
      continue;
    }
    let same;
    try {
      same = withoutVersionFields(file, before) === withoutVersionFields(file, after);
    } catch {
      same = false;
    }
    if (!same) out.push({ file, why: "changed beyond its version field" });
  }
  return out;
}

function ghExecutable() {
  return process.env.STABLE_GATE_GH || "gh";
}

/** Default GitHub query: `gh api <path>`, parsed. Throws on any failure. */
export function ghApi(path) {
  const r = spawnSync(ghExecutable(), ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run ${ghExecutable()}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`gh api ${path} exited ${r.status}: ${(r.stderr || "").trim()}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`gh api ${path} did not return JSON`);
  }
}

/**
 * Did the Windows checklist pass on npm version `previewVersion`?
 * `query(path)` returns parsed JSON or throws. Returns { ok, detail }.
 */
export function windowsVerification(slug, previewVersion, query = ghApi) {
  const name = `${VERIFY_ARTIFACT_PREFIX}${previewVersion}`;
  let listing;
  try {
    listing = query(`repos/${slug}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
  } catch (err) {
    return { ok: false, detail: `could not ask GitHub for '${name}' (${err.message}); not finding out is not a pass` };
  }
  const artifacts = (listing && Array.isArray(listing.artifacts) ? listing.artifacts : []).filter((a) => a && a.name === name);
  if (artifacts.length === 0) {
    return { ok: false, detail: `no '${name}' artifact: ${VERIFY_WORKFLOW_PATH} has not been run on ${previewVersion}` };
  }
  const rejected = [];
  for (const artifact of artifacts) {
    const runId = artifact.workflow_run && artifact.workflow_run.id;
    if (!runId) {
      rejected.push(`artifact ${artifact.id}: not linked to a run`);
      continue;
    }
    let run;
    try {
      run = query(`repos/${slug}/actions/runs/${runId}`);
    } catch (err) {
      rejected.push(`run ${runId}: could not read it (${err.message})`);
      continue;
    }
    const problems = [];
    if (run.path !== VERIFY_WORKFLOW_PATH) problems.push(`workflow is ${run.path}`);
    if (run.event !== "workflow_dispatch") problems.push(`event is ${run.event}`);
    if (run.head_branch !== VERIFY_BRANCH) problems.push(`branch is ${run.head_branch}`);
    if (run.status !== "completed") problems.push(`status is ${run.status}`);
    if (run.conclusion !== "success") problems.push(`conclusion is ${run.conclusion}`);
    if (problems.length === 0) return { ok: true, detail: `run ${runId} passed on ${previewVersion}` };
    rejected.push(`run ${runId}: ${problems.join(", ")}`);
  }
  return { ok: false, detail: `'${name}' exists but no run of it passed (${rejected.join("; ")})` };
}

/**
 * The whole decision. `query` is injectable for tests; the CLI uses `gh`.
 * Returns { status: "allowed" | "unmanaged" | "refused", reasons: string[], notes: string[] }.
 */
export function evaluate({ version, repo, slug, query = ghApi }) {
  const kind = classifyVersion(version);
  if (kind === "preview") {
    return { status: "unmanaged", reasons: [], notes: [`${version} is a preview version; the stable gate does not apply to it.`] };
  }
  if (kind === "unknown") {
    return {
      status: "refused",
      reasons: [`'${version}' is neither X.Y.Z nor X.Y.Z-(alpha|beta|rc).N; publish.yml would send it to the 'latest' dist-tag unchecked.`],
      notes: [],
    };
  }

  const reasons = [];
  const notes = [];

  const pkg = JSON.parse(git(repo, ["show", "HEAD:package.json"]));
  if (pkg.version !== version) {
    reasons.push(`HEAD's package.json says version ${pkg.version}, not ${version}; the gate would be judging a different tree than the one being published.`);
  }

  const tags = git(repo, ["tag", "--merged", "HEAD", "--list", `v${version}-*`]).split("\n").map((s) => s.trim()).filter(Boolean);
  const preview = pickLatestPreview(version, tags);
  if (!preview) {
    reasons.push(`no preview tag v${version}-(alpha|beta|rc).N is reachable from HEAD; a stable version must be preceded by a verified preview of the same content.`);
    return { status: "refused", reasons, notes };
  }
  notes.push(`comparing HEAD with the latest preview, v${preview}`);

  // 1. same content
  const diffs = disallowedDifferences(repo, `v${preview}`);
  if (diffs.length > 0) {
    reasons.push(
      `content differs from v${preview} in ${diffs.length} file(s) beyond ${[...ALLOWED_FILES].join(", ")} (version fields only for the JSON ones):\n` +
        diffs.slice(0, MAX_LISTED).map((d) => `      ${d.file}  (${d.why})`).join("\n") +
        (diffs.length > MAX_LISTED ? `\n      ... and ${diffs.length - MAX_LISTED} more` : ""),
    );
  } else {
    notes.push(`content matches v${preview} apart from the release bookkeeping`);
  }

  // 2. Windows verification of that preview
  const v = windowsVerification(slug, preview, query);
  if (v.ok) notes.push(v.detail);
  else reasons.push(`Windows verification: ${v.detail}`);

  return { status: reasons.length > 0 ? "refused" : "allowed", reasons, notes };
}

function slugFromPackage(repo) {
  try {
    const url = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).repository?.url ?? "";
    const m = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { version: null, repo: process.cwd(), slug: process.env.GITHUB_REPOSITORY || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = resolve(argv[++i] ?? "");
    else if (a === "--github-repo") args.slug = argv[++i] ?? null;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (args.version === null) args.version = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!args.version) throw new Error("usage: stable-gate.mjs <version> [--repo <dir>] [--github-repo <owner/name>]");
  return args;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`stable-gate: ${err.message}`);
    return 2;
  }
  const slug = args.slug || slugFromPackage(args.repo);
  if (!slug && classifyVersion(args.version) === "stable") {
    console.error("stable-gate: REFUSED. Cannot tell which GitHub repository to ask (set GITHUB_REPOSITORY or pass --github-repo).");
    return 1;
  }
  let result;
  try {
    result = evaluate({ version: args.version, repo: args.repo, slug, query: ghApi });
  } catch (err) {
    console.error(`stable-gate: REFUSED. The check itself failed: ${err.message}`);
    return 1;
  }
  for (const n of result.notes) console.log(`stable-gate: ${n}`);
  if (result.status === "refused") {
    console.error(`stable-gate: REFUSED to publish ${args.version}:`);
    for (const r of result.reasons) console.error(`  - ${r}`);
    return 1;
  }
  console.log(result.status === "allowed" ? `stable-gate: OK, ${args.version} may be published.` : "stable-gate: nothing to check.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
