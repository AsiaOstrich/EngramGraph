/**
 * XSPEC-416 R2 — the extension must not demand a newer platform than the engine.
 * The darwin arm was measured against real binaries (an extension built without a
 * deployment target: minos 26.0 vs the engine's 11.0 → FAIL). The linux and win32
 * parsers run on real tool output only in CI; these pin their parsing.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
type Mod = {
  compareVersions: (a: string, b: string) => number;
  maxGlibc: (s: string) => string | null;
  minos: (s: string) => string | null;
  dllImports: (s: string) => string[] | null;
  judge: (p: string, e: string, g: string) => { ok: boolean; detail: string };
};
const load = async () => (await import(join(ROOT, "scripts/algo-compat-check.mjs"))) as Mod;

const OBJDUMP = (max: string) => `
DYNAMIC SYMBOL TABLE:
0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.2.5) memcpy
0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.34) __libc_start_main
0000000000000000      DF *UND*  0000000000000000 (${max}) something
0000000000000000      DF *UND*  0000000000000000 (GLIBCXX_3.4.32) _ZNSt6thread
`;

const DUMPBIN = (dlls: string[]) => `
Dump of file libalgo.ryu_extension

File Type: DLL

  Image has the following dependencies:

    ${dlls.join("\n    ")}

  Summary

        1000 .data
`;

describe("compareVersions", () => {
  it("compares numerically, not as strings", async () => {
    const m = await load();
    expect(m.compareVersions("2.9", "2.38")).toBeLessThan(0);
    expect(m.compareVersions("26.0", "11.0")).toBeGreaterThan(0);
    expect(m.compareVersions("11", "11.0")).toBe(0);
  });
});

describe("linux", () => {
  it("passes when the extension needs no newer GLIBC than the engine", async () => {
    const m = await load();
    expect(m.judge("linux", OBJDUMP("GLIBC_2.38"), OBJDUMP("GLIBC_2.38")).ok).toBe(true);
  });

  it("fails when the extension needs a newer GLIBC — and GLIBCXX does not confuse it", async () => {
    const m = await load();
    const r = m.judge("linux", OBJDUMP("GLIBC_2.39"), OBJDUMP("GLIBC_2.38"));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("2.39");
    expect(r.detail).toContain("2.38");
  });

  it("refuses to pass when the engine's requirement cannot be read", async () => {
    const m = await load();
    expect(m.judge("linux", OBJDUMP("GLIBC_2.30"), "no symbols here").ok).toBe(false);
  });
});

describe("win32", () => {
  it("passes when every DLL the extension imports is also the engine's", async () => {
    const m = await load();
    const engine = DUMPBIN(["KERNEL32.dll", "MSVCP140.dll", "VCRUNTIME140.dll"]);
    expect(m.judge("win32", DUMPBIN(["KERNEL32.dll", "VCRUNTIME140.dll"]), engine).ok).toBe(true);
  });

  it("fails and names a DLL only the extension needs", async () => {
    const m = await load();
    const r = m.judge("win32", DUMPBIN(["KERNEL32.dll", "MSVCP140_ATOMIC_WAIT.dll"]), DUMPBIN(["KERNEL32.dll"]));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("msvcp140_atomic_wait.dll");
  });

  it("refuses to pass when dumpbin output cannot be parsed", async () => {
    const m = await load();
    expect(m.judge("win32", "garbage", DUMPBIN(["KERNEL32.dll"])).ok).toBe(false);
  });
});

describe("darwin", () => {
  it("fails on an extension built without a deployment target", async () => {
    const m = await load();
    const otool = (v: string) => `Load command 9\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos ${v}\n      sdk 26.0\n`;
    const r = m.judge("darwin", otool("26.0"), otool("11.0"));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("MACOSX_DEPLOYMENT_TARGET=11.0");
  });
});
