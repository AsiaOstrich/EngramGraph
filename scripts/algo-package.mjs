#!/usr/bin/env node
// implements XSPEC-416 R1
/**
 * Assemble one @asiaostrich/engramgraph-algo-<platform> package directory.
 *
 *   node scripts/algo-package.mjs <platform-key> <path/to/libalgo.ryu_extension> <out-dir> [source-run-url]
 *
 * The platform list and the extension version are read from
 * src/structural-memory/algo-extension.ts — the file engramgraph itself uses —
 * so there is one list, not a second copy here. test/algo-package-script.test.ts
 * asserts this parser returns exactly what that module exports.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function readAlgoConstants(root = ROOT) {
  const src = readFileSync(join(root, "src/structural-memory/algo-extension.ts"), "utf8");
  const version = /export const ALGO_EXTENSION_VERSION = "([^"]+)";/.exec(src)?.[1];
  const block = /export const ALGO_PLATFORM_PACKAGES[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1];
  if (!version || !block) throw new Error("could not read ALGO_EXTENSION_VERSION / ALGO_PLATFORM_PACKAGES from algo-extension.ts");
  const packages = Object.fromEntries([...block.matchAll(/"([a-z0-9]+-[a-z0-9]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  if (Object.keys(packages).length === 0) throw new Error("ALGO_PLATFORM_PACKAGES parsed as empty");
  return { version, packages };
}

export function packageJsonFor(platformKey, constants, sourceRun) {
  const name = constants.packages[platformKey];
  if (!name) throw new Error(`unknown platform ${platformKey}; expected one of ${Object.keys(constants.packages).join(", ")}`);
  const [os, cpu] = platformKey.split("-");
  return {
    name,
    version: constants.version,
    description: `Prebuilt ryugraph ALGO extension ${constants.version} for engramgraph on ${platformKey}, so god-nodes, communities and related work without network access.`,
    license: "MIT",
    os: [os],
    cpu: [cpu],
    files: ["libalgo.ryu_extension", "algo-extension.json", "LICENSE", "README.md"],
    repository: { type: "git", url: "git+https://github.com/AsiaOstrich/EngramGraph.git"},
    ...(sourceRun ? { engramgraphAlgo: { sourceRun } } : {}),
  };
}

async function main() {
  const [platformKey, extensionFile, outDir, sourceRun] = process.argv.slice(2);
  if (!platformKey || !extensionFile || !outDir) {
    console.error("usage: node scripts/algo-package.mjs <platform-key> <libalgo.ryu_extension> <out-dir> [source-run-url]");
    process.exit(2);
  }
  const constants = readAlgoConstants();
  const pkg = packageJsonFor(platformKey, constants, sourceRun);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(extensionFile, join(outDir, "libalgo.ryu_extension"));
  copyFileSync(join(ROOT, "node_modules/ryugraph/LICENSE"), join(outDir, "LICENSE"));
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    join(outDir, "algo-extension.json"),
    `${JSON.stringify({ extensionVersion: constants.version, platform: platformKey, sourceRun: sourceRun ?? null }, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, "README.md"),
    `# ${pkg.name}\n\n${pkg.description}\n\nInstalled automatically as an optional dependency of \`engramgraph\` on ${platformKey}; you do not need to install it yourself.\n\nThe extension is built from ryugraph's source (MIT, © Kùzu Inc. — see LICENSE). Version ${constants.version} matches ryugraph's extension version, not engramgraph's.\n`,
  );
  console.log(`assembled ${pkg.name}@${pkg.version} in ${outDir}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
