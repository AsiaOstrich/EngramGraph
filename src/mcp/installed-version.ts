// SPDX-License-Identifier: MIT
/**
 * Is the MCP server that is running the version that is installed? (issue #18)
 *
 * An `egr-mcp` process is started by an MCP client (Claude Code, ...) and keeps
 * running until that client stops it. `npm i -g engramgraph@<version>` meanwhile
 * replaces the files on disk, so the process goes on serving the OLD code with
 * nothing telling the user. On Windows it is worse: the running process holds
 * `ryugraph\ryujs.node` open, npm cannot delete the old directory, and the upgrade
 * still looks like it worked. (macOS and Linux can delete open files, so there the
 * server is just as stale, but npm leaves no warning behind that hints at it.)
 *
 * The server knows the version it was started with: it is the constant it
 * reports in `initialize` (`EGR_VERSION`, fixed for the life of the process). This
 * module reads the version that is installed *now*: the `package.json` of the
 * `engramgraph` package that this file sits in, read from disk on every call.
 * The path is resolved by NAME, not by file identity: when npm renames the old
 * directory to `.engramgraph-<random>` and puts the new package at the original
 * name, the path this process was loaded from now names the NEW package, which is
 * exactly what is wanted.
 *
 * **It never answers "current" by default.** When the installed version cannot be
 * read (no package.json found, unreadable, damaged), the answer is `unknown`, not
 * `current`: a check that says "fine" whenever it cannot look is the failure this
 * exists to remove.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ServerVersionStatus = "current" | "stale" | "unknown";

export interface ServerVersionReport {
  /** The version this server process was started with (does not change while it runs). */
  runningVersion: string;
  /** The version of the package on disk now; null when it could not be read. */
  installedVersion: string | null;
  /**
   * `current`: the same. `stale`: they differ (the process was started before an upgrade, or
   * before a downgrade). `unknown`: the installed version could not be read, so nothing is
   * claimed either way.
   */
  status: ServerVersionStatus;
  message: string;
  /**
   * Names of `.engramgraph-<hash>` directories that sit next to the installed package, left by an
   * earlier `npm i -g` (issue #26). Empty when there are none, and when the installed package could
   * not be located (`status: "unknown"`). When it is not empty, `message` says what to do.
   */
  upgradeLeftovers: string[];
}

const PACKAGE_NAME = "engramgraph";

type Installed = { version: string; dir: string } | { problem: string };

/**
 * Find the `engramgraph` package that contains `startDir`, and read its version from disk, now.
 * Walks up from `startDir`; a package.json whose name is not `engramgraph` is passed over.
 * The nearest package.json that cannot be parsed is a problem, not a reason to keep
 * walking (a damaged file is not evidence that a package further up is the right one).
 */
function locateInstalled(startDir: string): Installed {
  let dir = startDir;
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        return { problem: `${file} could not be read (${e instanceof Error ? e.message : String(e)})` };
      }
      const obj = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ?(parsed as Record<string, unknown>) : undefined;
      if (obj === undefined) return { problem: `${file} is not a package.json object` };
      if (obj.name === PACKAGE_NAME) {
        return typeof obj.version === "string" && obj.version !== ""
          ? { version: obj.version, dir }
          : { problem: `${file} has no version` };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return { problem: `no ${PACKAGE_NAME} package.json found above ${startDir}` };
    dir = parent;
  }
}

/** The version of the `engramgraph` package that contains `startDir`, from disk, now. */
export function readInstalledVersion(startDir: string): { version: string } | { problem: string } {
  const found = locateInstalled(startDir);
  return "problem" in found ? found : { version: found.version };
}

/**
 * `.engramgraph-<hash>` directories next to the installed package `packageDir`. // implements issue #26
 *
 * npm renames the installed copy to `.<name>-<hash>` while it upgrades and deletes it at the end;
 * the hash is a function of the package's path, so it is the same name every time. On Windows the
 * delete fails while a running `egr-mcp` holds `ryugraph\ryujs.node`, the directory stays, and the
 * next upgrade has to rename onto that name and fails with EBUSY.
 *
 * Unlike the install-time check (`preinstall.js`), this runs when no upgrade is in flight, so every
 * such directory is a leftover and none needs to be told apart from npm's own copy. Only the
 * package's own `node_modules` is looked at (a checkout or an `npm link` has none and reports
 * nothing). An unreadable directory reports nothing rather than failing `doctor`, which must
 * answer when other things are broken.
 */
export function findUpgradeLeftovers(packageDir: string): string[] {
  const parent = dirname(packageDir);
  if (basename(packageDir) !== PACKAGE_NAME || basename(parent) !== "node_modules") return [];
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(`.${PACKAGE_NAME}-`))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function leftoverSentence(names: string[], packageDir: string): string {
  const parent = dirname(packageDir);
  return (
    ` A previous upgrade left ${names.join(", ")} next to the installed package, in ${parent}. ` +
    "npm moves the installed copy there while it upgrades and deletes it at the end; on Windows it cannot while an egr-mcp holds a file in it open, and the next upgrade then fails with EBUSY. " +
    "Close every MCP client that runs egr-mcp (for example Claude Code), delete " +
    `${names.map((n) => join(parent, n)).join(", ")}, and only then upgrade again.`
  );
}

/**
 * Compare the version a server was started with to the one installed now.
 * `startDir` defaults to the directory of this file (inside the installed package);
 * tests pass their own.
 */
export function checkServerVersion(
  runningVersion: string,
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): ServerVersionReport {
  const installed = locateInstalled(startDir);
  if ("problem" in installed) {
    return {
      runningVersion,
      installedVersion: null,
      status: "unknown",
      upgradeLeftovers: [],
      message:
        `cannot determine whether this MCP server is current: it is running version ${runningVersion}, ` +
        `and the installed version could not be read (${installed.problem}). ` +
        "Compare `egr --version` with the running version above (if the client starts the same egr-mcp that is on your PATH); if they differ, restart the MCP client (for example Claude Code).",
    };
  }
  const upgradeLeftovers = findUpgradeLeftovers(installed.dir);
  const leftover = upgradeLeftovers.length === 0 ? "" : leftoverSentence(upgradeLeftovers, installed.dir);
  if (installed.version === runningVersion) {
    return {
      runningVersion,
      installedVersion: installed.version,
      status: "current",
      upgradeLeftovers,
      message: `this MCP server is running version ${runningVersion}, the version that is installed.${leftover}`,
    };
  }
  return {
    runningVersion,
    installedVersion: installed.version,
    status: "stale",
    upgradeLeftovers,
    message:
      `this MCP server is still running version ${runningVersion}, but version ${installed.version} is installed. ` +
      "The server was started before the package on disk changed and keeps serving the version it started with: " +
      `restart the MCP client (for example Claude Code) so that it starts the installed one.${leftover}`,
  };
}
