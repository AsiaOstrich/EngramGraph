#!/usr/bin/env node
// implements XSPEC-416 R2
/**
 * The ALGO extension must not demand a newer platform than the engine that loads it.
 *
 *   node scripts/algo-compat-check.mjs <linux|darwin|win32> <libalgo.ryu_extension> <ryujs-*.node>
 *
 * Otherwise engramgraph runs and the extension does not load — measured before this
 * existed: ryugraph's own engine needs GLIBC 2.38 / macOS 11.0, and an extension built
 * on a current Mac without a deployment target asked for macOS 26.0.
 *
 *   linux   highest GLIBC_ symbol version the extension needs  <=  the engine's
 *   darwin  LC_BUILD_VERSION minos                             <=  the engine's
 *   win32   every DLL the extension imports is also imported by the engine
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function maxGlibc(objdumpOutput) {
  const versions = [...objdumpOutput.matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)].map((m) => m[1]);
  if (versions.length === 0) return null;
  return versions.sort(compareVersions).at(-1);
}

export function minos(otoolOutput) {
  const idx = otoolOutput.indexOf("LC_BUILD_VERSION");
  if (idx >= 0) {
    const m = /minos\s+(\d+(?:\.\d+)*)/.exec(otoolOutput.slice(idx));
    if (m) return m[1];
  }
  const legacy = otoolOutput.indexOf("LC_VERSION_MIN_MACOSX");
  if (legacy >= 0) {
    const m = /version\s+(\d+(?:\.\d+)*)/.exec(otoolOutput.slice(legacy));
    if (m) return m[1];
  }
  return null;
}

export function dllImports(dumpbinOutput) {
  const start = dumpbinOutput.indexOf("has the following dependencies");
  if (start < 0) return null;
  const tail = dumpbinOutput.slice(start).split(/\r?\n/).slice(1);
  const dlls = [];
  for (const line of tail) {
    const t = line.trim();
    if (!t) {
      if (dlls.length > 0) break;
      continue;
    }
    if (/^Summary$/i.test(t)) break;
    if (/\.dll$/i.test(t)) dlls.push(t.toLowerCase());
  }
  return dlls;
}

/** Returns { ok, detail }. Pure: takes tool outputs, not files. */
export function judge(platform, extOut, engineOut) {
  if (platform === "linux") {
    const e = maxGlibc(extOut);
    const g = maxGlibc(engineOut);
    if (!g) return { ok: false, detail: "could not read the engine's GLIBC requirement — refusing to pass an unmeasured check" };
    if (!e) return { ok: true, detail: `extension needs no versioned GLIBC symbols; engine needs GLIBC ${g}` };
    return compareVersions(e, g) <= 0
      ? { ok: true, detail: `extension needs GLIBC ${e}, engine needs ${g}` }
      : { ok: false, detail: `extension needs GLIBC ${e} but the engine only needs ${g}: it would fail to load where engramgraph runs` };
  }
  if (platform === "darwin") {
    const e = minos(extOut);
    const g = minos(engineOut);
    if (!e || !g) return { ok: false, detail: `could not read minos (extension ${e}, engine ${g}) — refusing to pass an unmeasured check` };
    return compareVersions(e, g) <= 0
      ? { ok: true, detail: `extension minos ${e}, engine minos ${g}` }
      : { ok: false, detail: `extension needs macOS ${e} but the engine supports ${g}: set MACOSX_DEPLOYMENT_TARGET=${g}` };
  }
  if (platform === "win32") {
    const e = dllImports(extOut);
    const g = dllImports(engineOut);
    if (!e || !g) return { ok: false, detail: "could not read DLL imports — refusing to pass an unmeasured check" };
    const extra = e.filter((d) => !g.includes(d));
    return extra.length === 0
      ? { ok: true, detail: `extension imports ${e.length} DLL(s), all also imported by the engine` }
      : { ok: false, detail: `extension imports DLL(s) the engine does not: ${extra.join(", ")}` };
  }
  return { ok: false, detail: `unknown platform ${platform}` };
}

function toolOutput(platform, file) {
  if (platform === "linux") return execFileSync("objdump", ["-T", file], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (platform === "darwin") return execFileSync("otool", ["-l", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (platform === "win32") return execFileSync("dumpbin", ["/dependents", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  throw new Error(`unknown platform ${platform}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [platform, ext, engine] = process.argv.slice(2);
  if (!platform || !ext || !engine) {
    console.error("usage: node scripts/algo-compat-check.mjs <linux|darwin|win32> <libalgo.ryu_extension> <ryujs-*.node>");
    process.exit(2);
  }
  const r = judge(platform, toolOutput(platform, ext), toolOutput(platform, engine));
  console.log(`${r.ok ? "PASS" : "FAIL"} ${platform}: ${r.detail}`);
  process.exit(r.ok ? 0 : 1);
}
