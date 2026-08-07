#!/usr/bin/env node
/**
 * Do the packages a consumer of engramgraph actually installs carry known
 * advisories?
 *
 * The obvious implementation — `npm audit --omit=dev` in this repo — answers a
 * different question, and on 2026-08-08 it answered it wrongly enough to be
 * worth writing down.
 *
 * package.json carries `overrides: { "cmake-js": "^8.0.0" }`, added on
 * 2026-06-12 in fddd07e with the message "clearing remaining tar CVEs". It did
 * clear them: in this repo, ryugraph resolves cmake-js@8 and tar@7.5.22, and
 * `npm audit --omit=dev` reports nothing. But npm's `overrides` govern the
 * dependency tree of the project that declares them and are not part of the
 * contract a published package hands to its consumers. Install engramgraph@0.9.1
 * into an empty directory and ryugraph pulls cmake-js@7.4.0, which pulls
 * tar@6.2.1 — twelve advisories, one critical and six high. That was true for
 * roughly two months while the repo's own audit stayed green.
 *
 * So this script audits what `npm pack` produces, installed the way a consumer
 * installs it. It is slower than auditing in place. It is the only version of
 * the question worth asking for a package that is published.
 *
 * Exit codes
 *   0  no advisories at or above the threshold, or every one of them is
 *      accepted in security/accepted-advisories.json and not yet expired
 *   1  an advisory is unaccepted, or its acceptance has expired
 *   2  the check could not run — pack failed, install failed, npm audit
 *      produced something unparseable. Distinct from 0 on purpose: "found
 *      nothing" and "never looked" are not the same result, and they arrive
 *      looking identical if you let them share an exit code.
 *
 * Acceptances carry a mandatory `expires` date. An exception with no clock is
 * a deletion with better manners — it removes the gate and leaves the paperwork.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCEPTANCES = join(ROOT, "security", "accepted-advisories.json");
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const THRESHOLD = process.env.EGR_AUDIT_LEVEL ?? "high";

function die(code, ...lines) {
  for (const line of lines) console.error(line);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

if (!SEVERITIES.includes(THRESHOLD)) {
  die(2, `[audit] EGR_AUDIT_LEVEL=${THRESHOLD} is not one of ${SEVERITIES.join(", ")}.`);
}
const minIndex = SEVERITIES.indexOf(THRESHOLD);

// ── What a consumer installs ────────────────────────────────────────────────
// `npm pack` runs prepack, so this builds the package first — deliberately.
// Auditing a tree assembled from a stale dist would be auditing a version of
// the package that is not the one about to ship.
let tarball;
try {
  const out = run("npm", ["pack", "--pack-destination", tmpdir()], { cwd: ROOT });
  tarball = out.trim().split("\n").pop().trim();
} catch (error) {
  die(2, "[audit] npm pack failed — the check did not run.", error.stdout ?? "", error.stderr ?? "");
}
const tarballPath = join(tmpdir(), tarball);
if (!existsSync(tarballPath)) {
  die(2, `[audit] npm pack reported ${tarball} but ${tarballPath} does not exist — the check did not run.`);
}

const sandbox = mkdtempSync(join(tmpdir(), "egr-shipped-audit-"));
writeFileSync(
  join(sandbox, "package.json"),
  `${JSON.stringify({ name: "egr-shipped-audit", version: "0.0.0", private: true }, null, 2)}\n`,
);

try {
  // --ignore-scripts: this resolves and inspects a dependency tree, it never
  // loads the package. Skipping native builds costs nothing here and saves
  // several minutes. (It would invalidate a *load* test — that mistake has
  // been made in this repo before and produced a failure that belonged to the
  // probe rather than to the package.)
  run("npm", ["install", tarballPath, "--ignore-scripts", "--legacy-peer-deps"], { cwd: sandbox });
} catch (error) {
  die(2, "[audit] installing the packed tarball failed — the check did not run.", error.stdout ?? "", error.stderr ?? "");
}

const installed = join(sandbox, "node_modules", "engramgraph", "package.json");
if (!existsSync(installed)) {
  die(2, `[audit] ${installed} is missing after install — the check did not run.`);
}

// ── Audit it ────────────────────────────────────────────────────────────────
// npm audit exits non-zero when it finds something, so a throw here is the
// normal path, not an error. What matters is whether stdout parses.
let report;
{
  let raw;
  try {
    raw = run("npm", ["audit", "--omit=dev", "--json"], { cwd: sandbox });
  } catch (error) {
    raw = error.stdout;
  }
  if (!raw || !raw.trim()) {
    die(2, "[audit] npm audit produced no output — the check did not run.");
  }
  try {
    report = JSON.parse(raw);
  } catch {
    die(2, "[audit] npm audit output did not parse as JSON — the check did not run.", raw.slice(0, 400));
  }
}

const scanned = report.metadata?.dependencies?.prod;
if (typeof scanned !== "number" || scanned === 0) {
  die(2, `[audit] npm audit reports ${scanned} production dependencies — the check did not run.`);
}

// npm reports a parent package as vulnerable when a descendant is. Those rows
// name engramgraph and ryugraph themselves, which is true but not actionable:
// the finding to act on is the package that actually carries the advisory.
const findings = [];
for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
  if (SEVERITIES.indexOf(entry.severity) < minIndex) continue;
  const advisories = (entry.via ?? []).filter((v) => typeof v === "object");
  if (advisories.length === 0) continue; // parent-of-a-vulnerable-child row
  findings.push({
    name,
    severity: entry.severity,
    range: entry.range,
    advisories: advisories.map((a) => ({ id: a.url?.split("/").pop() ?? a.source, title: a.title, severity: a.severity })),
  });
}

// ── Acceptances ─────────────────────────────────────────────────────────────
let accepted = [];
if (existsSync(ACCEPTANCES)) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ACCEPTANCES, "utf8"));
  } catch (error) {
    die(2, `[audit] ${ACCEPTANCES} did not parse — the check did not run.`, String(error));
  }
  accepted = parsed.accepted ?? [];
  for (const item of accepted) {
    for (const field of ["package", "advisory", "reason", "expires"]) {
      if (!item[field]) {
        die(2, `[audit] an acceptance is missing "${field}" — the check did not run.`, JSON.stringify(item));
      }
    }
    if (Number.isNaN(Date.parse(item.expires))) {
      die(2, `[audit] acceptance for ${item.package} has an unparseable expires: ${item.expires}`);
    }
  }
}

const today = new Date();
const expired = [];
const covered = [];
const uncovered = [];

for (const finding of findings) {
  for (const advisory of finding.advisories) {
    const match = accepted.find(
      (a) => a.package === finding.name && (a.advisory === advisory.id || a.advisory === "*"),
    );
    if (!match) {
      uncovered.push({ finding, advisory });
    } else if (new Date(match.expires) < today) {
      expired.push({ finding, advisory, match });
    } else {
      covered.push({ finding, advisory, match });
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
// Printed on the way out whether or not anything was found. A gate that only
// speaks when it fails leaves "scanned 180 packages, all clean" and "scanned
// nothing" reading the same in a log.
console.log(`[audit] Consumer resolution of ${tarball}: ${scanned} production packages scanned.`);
console.log(`[audit] Threshold: ${THRESHOLD} and above. ${findings.length} package(s) over it.`);

// Grouped by acceptance rather than one line per advisory. A `*` acceptance
// covering twelve advisories printed its reason twelve times, and a wall of
// identical prose is a thing readers skip — which defeats the point of making
// the reason mandatory. The count stays visible; the prose is said once.
const byAcceptance = new Map();
for (const { finding, advisory, match } of covered) {
  const key = `${match.package}|${match.advisory}|${match.expires}`;
  if (!byAcceptance.has(key)) byAcceptance.set(key, { match, ids: [], severities: new Set() });
  const group = byAcceptance.get(key);
  group.ids.push(advisory.id);
  group.severities.add(advisory.severity);
  group.name = finding.name;
}
for (const { match, ids, severities, name } of byAcceptance.values()) {
  const worst = SEVERITIES.filter((s) => severities.has(s)).pop();
  console.log(`  ACCEPTED  ${name} — ${ids.length} advisor${ids.length === 1 ? "y" : "ies"}, worst ${worst}, expires ${match.expires}`);
  console.log(`            ${ids.join(", ")}`);
  console.log(`            ${match.reason}`);
}
for (const { finding, advisory, match } of expired) {
  console.error(`  EXPIRED   ${finding.name} ${advisory.id} — acceptance ran out on ${match.expires}`);
}
for (const { finding, advisory } of uncovered) {
  console.error(`  UNACCEPTED ${finding.name}@${finding.range} [${advisory.severity}] ${advisory.id}`);
  console.error(`             ${advisory.title}`);
}

if (expired.length > 0 || uncovered.length > 0) {
  console.error("");
  console.error(
    `[audit] FAIL — ${uncovered.length} unaccepted, ${expired.length} expired. ` +
      `Fix the dependency, or add a dated acceptance to security/accepted-advisories.json.`,
  );
  process.exit(1);
}

console.log(`[audit] OK — nothing at ${THRESHOLD} or above that is not accepted and current.`);
