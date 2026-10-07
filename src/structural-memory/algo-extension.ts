// implements XSPEC-416
/**
 * Where the ryugraph ALGO extension comes from.
 *
 * `god-nodes`, `communities` and `related` need ryugraph's ALGO extension, and
 * `INSTALL ALGO` downloads it from extension.ryugraph.io on first use. A
 * corporate intranet cannot reach that host (consumer report on 0.11.0,
 * Windows 11), so the extension now ships prebuilt in one npm package per
 * platform, listed as optional dependencies: npm installs only the one that
 * matches the machine, and this module finds it.
 *
 * Facts this rests on, all measured before it was written (XSPEC-416):
 *   - the extension loads from any path with `LOAD EXTENSION "<path>"` — no
 *     INSTALL, no network, nothing written to the home directory;
 *   - on Windows a backslash path is a parser error; forward slashes load;
 *   - a single-quoted path breaks on an apostrophe; the double-quoted,
 *     escaped form does not.
 *
 * The packages are rebuilt only when ryugraph's extension version changes,
 * not on every engramgraph release. `ALGO_EXTENSION_VERSION` is pinned to the
 * engine by a test (R4), so an engine upgrade without a rebuild fails CI
 * instead of shipping a mismatch.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Must equal ryugraph's RYU_EXTENSION_VERSION — enforced by test/algo-extension-bundled.test.ts. */
export const ALGO_EXTENSION_VERSION = "25.9.0";

/**
 * One package per platform where ryugraph's engine actually runs.
 *
 * linux-arm64 is deliberately absent: ryugraph 25.9.1 ships the x86-64 engine under
 * the arm64 filename (byte-identical files; predictable-labs/ryugraph#48), so
 * engramgraph cannot run there and an extension package would load into nothing.
 * test/algo-extension-bundled.test.ts turns red the day those two files differ,
 * which is the signal to add it back.
 */
export const ALGO_PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  "win32-x64": "@asiaostrich/engramgraph-algo-win32-x64",
  "linux-x64": "@asiaostrich/engramgraph-algo-linux-x64",
  "darwin-arm64": "@asiaostrich/engramgraph-algo-darwin-arm64",
  "darwin-x64": "@asiaostrich/engramgraph-algo-darwin-x64",
};

export const ALGO_EXTENSION_FILE = "libalgo.ryu_extension";

export function algoPackageFor(platform: string, arch: string): string | null {
  return ALGO_PLATFORM_PACKAGES[`${platform}-${arch}`] ?? null;
}

export interface BundledAlgo {
  /** The package this platform should have, or null when none is built for it. */
  pkg: string | null;
  /** Forward-slash path to the extension file, or null when it is not installed. */
  path: string | null;
}

export interface ResolveDeps {
  platform?: string;
  arch?: string;
  resolve?: (specifier: string) => string;
  exists?: (path: string) => boolean;
}

/** Find this platform's extension package, if npm installed it. */
export function resolveBundledAlgo(deps: ResolveDeps = {}): BundledAlgo {
  const pkg = algoPackageFor(deps.platform ?? process.platform, deps.arch ?? process.arch);
  if (!pkg) return { pkg: null, path: null };
  const resolve = deps.resolve ?? createRequire(import.meta.url).resolve;
  const exists = deps.exists ?? existsSync;
  let manifest: string;
  try {
    manifest = resolve(`${pkg}/package.json`);
  } catch {
    return { pkg, path: null };
  }
  // Built with forward slashes throughout: `join` would reintroduce backslashes
  // on Windows, and a backslash path is a parser error there.
  // Normalise before `dirname`: a posix `dirname` sees no separator in a backslash path.
  const file = `${dirname(manifest.replace(/\\/g, "/"))}/${ALGO_EXTENSION_FILE}`;
  return exists(join(file)) ? { pkg, path: file } : { pkg, path: null };
}

/**
 * The statement that loads the extension from `path`. Double-quoted and
 * escaped: a single-quoted path breaks on an apostrophe (measured).
 */
export function algoLoadStatement(path: string): string {
  const quoted = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `LOAD EXTENSION "${quoted}";`;
}

let resolverOverride: (() => BundledAlgo) | null = null;

/** Replace the resolver (tests, and callers that ship the extension elsewhere). `null` restores the default. */
export function setBundledAlgoResolver(fn: (() => BundledAlgo) | null): void {
  resolverOverride = fn;
}

export function currentBundledAlgo(): BundledAlgo {
  return resolverOverride ? resolverOverride() : resolveBundledAlgo();
}

// --- Where the extension would come from on THIS machine (XSPEC-457 R3) ------

/** The commands that load the ALGO extension. One list, shared by the error text, `doctor` and the tests. */
export const ALGO_BACKED_COMMAND_LIST: readonly string[] = ["god-nodes", "communities", "related"];

/**
 * ryugraph's own platform directory names under `~/.ryu/extension/<version>/`.
 * Only the three that have been observed are listed (linux_amd64 and win_amd64
 * from this repo's CI and its offline help text; osx_arm64 from a real cache
 * directory). darwin-x64 is deliberately absent: its spelling has not been
 * seen, and a guessed directory name would turn "cache present" into a
 * statement about a path that may never exist.
 */
const RYU_PLATFORM_DIR: Readonly<Record<string, string>> = {
  "win32-x64": "win_amd64",
  "linux-x64": "linux_amd64",
  "darwin-arm64": "osx_arm64",
};

export type AlgoSourceKind =
  /** The platform's `@asiaostrich/engramgraph-algo-*` package is installed; loaded by path, no network. */
  | "bundled-package"
  /** No package, but ryugraph's own cache already holds the extension; `INSTALL ALGO` finds it locally. */
  | "user-cache"
  /** Neither is present; the first `god-nodes`/`communities`/`related` will download it. */
  | "download"
  /** Cannot tell (a platform whose cache directory name is not known). Said as such, not guessed. */
  | "undetermined";

export interface AlgoSource {
  source: AlgoSourceKind;
  /** The platform package expected here, or null when none is built for this platform. */
  package: string | null;
  /** The extension file that would be loaded, when one is present. */
  path: string | null;
  /** One sentence for a human. */
  detail: string;
}

export interface AlgoSourceDeps {
  platform?: string;
  arch?: string;
  home?: string;
  bundled?: BundledAlgo;
  exists?: (path: string) => boolean;
}

/**
 * Work out, from what is on disk, how this machine would get the extension —
 * without loading it and without touching the network.
 *
 * `doctor` used to print a fixed list of commands "that need network". 0.12.0
 * ships the extension inside the platform package, so on a normal install the
 * list was wrong: a Windows 11 user with an empty `~/.ryu/extension/25.9.0/win_amd64`
 * ran all three commands and got results. This reads the same resolver the
 * commands use (`currentBundledAlgo`), so `doctor` and the commands cannot
 * disagree about where the extension comes from.
 */
export function describeAlgoSource(deps: AlgoSourceDeps = {}): AlgoSource {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const bundled = deps.bundled ?? currentBundledAlgo();
  const exists = deps.exists ?? existsSync;
  if (bundled.path) {
    return {
      source: "bundled-package",
      package: bundled.pkg,
      path: bundled.path,
      detail: `loaded from the installed package ${bundled.pkg}; no download`,
    };
  }
  const dirName = RYU_PLATFORM_DIR[`${platform}-${arch}`];
  if (!dirName) {
    return {
      source: "undetermined",
      package: bundled.pkg,
      path: null,
      detail:
        `no prebuilt package for ${platform}-${arch} and this platform's ryugraph cache directory is not known, ` +
        `so whether the first run downloads the extension cannot be determined`,
    };
  }
  const home = deps.home ?? homedir();
  const cached = `${home.replace(/\\/g, "/")}/.ryu/extension/${ALGO_EXTENSION_VERSION}/${dirName}/algo/${ALGO_EXTENSION_FILE}`;
  if (exists(cached)) {
    return {
      source: "user-cache",
      package: bundled.pkg,
      path: cached,
      detail: `${bundled.pkg ?? "the platform package"} is not installed, but ryugraph's cache already holds the extension; no download`,
    };
  }
  return {
    source: "download",
    package: bundled.pkg,
    path: null,
    detail:
      `${bundled.pkg ?? "no platform package"} is not installed and ryugraph's cache has no extension, ` +
      `so the first god-nodes/communities/related downloads it from extension.ryugraph.io`,
  };
}
