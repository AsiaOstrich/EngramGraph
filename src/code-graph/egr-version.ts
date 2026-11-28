/**
 * Which egr wrote a graph, and what to do when that egr is NEWER than the one now running
 * (dev-platform #309).
 *
 * The graph database itself does not say which egr built it. The parse-health manifest beside it
 * (`<graph>.parse-manifest.json`) already travels with the graph and is rewritten by every index run,
 * so the record lives there as `graphEgrVersion`: the NEWEST egr that has written this graph's index
 * data. (`ParseManifest.egrVersion` is a different fact: the parser of the last run, which an older
 * egr overwrites; it fingerprints parsing, it does not remember how new the graph is.)
 *
 * Why it matters: `egr index --clean` empties the graph and rebuilds it with the egr that is running.
 * An older egr doing that to a graph a newer one wrote throws away what the newer one stored — and the
 * SAGE `confidence` that was accumulated from real feedback does not come back from a re-index
 * (`graph-db/schema-migration.ts` says so in its module doc). Nothing used to tell the user.
 *
 * A graph with no record (built before this field existed, or its manifest is gone) is "unknown, so
 * older": it is never refused and never warned about, because that is every graph that exists today.
 */

import type { ParseManifest } from "./parse-manifest.js";

interface Parsed {
  core: [number, number, number];
  /** Dot-separated pre-release identifiers; empty for a release. */
  pre: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v: string): Parsed | null {
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/**
 * Semver precedence (semver.org §11): `<0 / 0 / >0` for `a` older than / equal to / newer than `b`, or
 * `null` when either is not a version we can order. A pre-release is OLDER than its release
 * (`0.16.0-beta.2 < 0.16.0`); numeric identifiers compare as numbers and rank below alphanumeric ones;
 * a longer pre-release outranks its own prefix (`beta < beta.1`). Build metadata is ignored.
 */
export function compareEgrVersions(a: string, b: string): number | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // a release outranks any of its pre-releases
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // fewer identifiers = older
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1; // numeric identifiers rank below alphanumeric ones
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The marker to store after a write by `current`: never lower than the one already recorded. */
export function graphVersionAfterWrite(recorded: string | undefined, current: string): string {
  if (!recorded) return current;
  const c = compareEgrVersions(recorded, current);
  return c !== null && c > 0 ? recorded : current;
}

/**
 * The version of the egr that wrote this graph, when it is NEWER than `current` — else `null`
 * (no manifest, no record, an equal or older one, or one we cannot order: all "nothing to say").
 */
export function newerGraphVersion(manifest: Pick<ParseManifest, "graphEgrVersion"> | null, current: string): string | null {
  const recorded = manifest?.graphEgrVersion;
  if (typeof recorded !== "string") return null;
  const c = compareEgrVersions(recorded, current);
  return c !== null && c > 0 ? recorded : null;
}

/** The warning every command prints when it opens a graph a newer egr wrote. */
export function newerGraphWarning(graphVersion: string, current: string): string {
  return (
    `[egr] warning: this graph was last written by egr ${graphVersion}, which is newer than this egr ${current}. ` +
    `Reading it is fine. Writing to it with an older egr can lose data the newer one stored: ` +
    `\`egr index --clean\` is refused (add --allow-downgrade to do it anyway), and the SAGE confidence a rebuild resets does not come back. ` +
    `Upgrade egr (npm install -g engramgraph@latest) to work with this graph.`
  );
}

/** The error `--clean` stops with, before it touches the graph. */
export function cleanRefusedMessage(graphVersion: string, current: string): string {
  return (
    `--clean refused: this graph was last written by egr ${graphVersion}, newer than this egr ${current}. ` +
    `--clean empties the graph and rebuilds it with the egr that is running, so the SAGE confidence accumulated from feedback would be reset to the default and does not come back from a re-index. ` +
    `Upgrade egr (npm install -g engramgraph@latest) and run it again; if you really want an older egr to rebuild this graph, add --allow-downgrade. ` +
    `The graph was not emptied.`
  );
}
