// SPDX-License-Identifier: MIT
/**
 * 給「啟動編譯後的 CLI」那幾支測試用的守衛。
 *
 * 🔴 為什麼需要它：2026-09-04 把 `cli.test.ts` 與 `scip-cli.test.ts` 從
 *    `npx tsx src/cli/index.ts` 改成 `node dist/cli/index.js`（理由見那兩個檔的註解：
 *    `tsx` 不是這個 repo 的相依，CI 上每次都要下載而且會卡住）。
 *
 *    那個改動是對的，但它**帶進一個新的失效方式**：`dist/` 是建置產物。
 *    改完 `src/` 而沒有重建時，這些測試會拿**上一個版本**去跑——而且全部通過。
 *    「測試綠了」於是變成一句關於舊程式碼的陳述，而那與關於新程式碼的陳述長得一樣。
 *
 *    這正是 XSPEC-397 §9.5 記下的那個形狀（那次是伺服器：靜態檔每次請求都重讀，
 *    而 import 進來的模組在行程啟動時就定了）。同一個病，不同的載體。
 *
 * ⚠️ 它不會自動重建。自動重建會讓每次跑測試都多花十幾秒，而且會**掩蓋**
 *    「你忘了建」這件事——那正是要被看見的東西。它只是把它講出來。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 走訪 src/ 找最新的修改時間。**不列舉檔案**——新目錄自己會被算進來。 */
function newestSourceMtime(srcDir: string): { path: string; mtimeMs: number } | null {
  let newest: { path: string; mtimeMs: number } | null = null;
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs|json)$/.test(name)) continue;
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: st.mtimeMs };
    }
  };
  visit(srcDir);
  return newest;
}

/**
 * 在啟動 `dist/` 之前呼叫。`dist` 比 `src` 舊就擲出，並說明白要做什麼。
 *
 * 拿不到任何一邊的時間就**安靜通過**：量不到不是失敗，而在這裡誤擋的代價
 * （測試在乾淨環境裡跑不起來）比漏擋高。
 */
export function assertDistIsFresh(repoRoot: string, distEntry: string): void {
  const newest = newestSourceMtime(join(repoRoot, "src"));
  if (!newest) return; // 看不到 src/ —— 量不到，不是紅
  let distMtime: number;
  try {
    distMtime = statSync(distEntry).mtimeMs;
  } catch {
    throw new Error(
      `這支測試要啟動 ${distEntry}，而它不存在。\n` +
        `跑一次 \`npm run build\`（或 \`npm install\`，prepare 會做同一件事）。`,
    );
  }
  if (newest.mtimeMs > distMtime) {
    const lagSec = Math.round((newest.mtimeMs - distMtime) / 1000);
    throw new Error(
      `dist/ 比 src/ 舊 ${lagSec} 秒——這支測試會啟動**上一個版本**的 CLI 然後通過。\n` +
        `  最新的原始碼：${newest.path}\n` +
        `  要跑的東西：  ${distEntry}\n` +
        `跑一次 \`npm run build\` 再跑測試。\n` +
        `（不自動重建是刻意的：自動重建會掩蓋「忘了建」這件事，而那正是要被看見的。）`,
    );
  }
}
