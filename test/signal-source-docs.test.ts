import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  GitHistorySignalSource,
  TestExitCodeSignalSource,
} from "../src/adapters/signal-source.js";

/**
 * Keeps the docs honest about SAGE signal sources.
 *
 * The claim in the README tagline and defaults sentence is: confidence
 * feedback works when feedback is supplied (see test/recall-quality.test.ts),
 * but NO automatic signal source ships. `GitHistorySignalSource` and
 * `TestExitCodeSignalSource` are placeholders that return no events.
 *
 * Earlier docs said "Default: GitHistorySignalSource, TestExitCodeSignalSource"
 * and listed "git signals" among the working-out-of-the-box defaults, which
 * promised an automatic feedback source that does not exist.
 *
 * Two layers:
 *  1. Doc-vs-doc: no doc may present those two classes as defaults, list git
 *     signals as a default, or call Phase 4b "in progress".
 *  2. Doc-vs-code: the placeholders still return []. If someone implements
 *     either class, the "no automatic source ships" sentences in all three
 *     READMEs and the four API docs become false and MUST be revisited — this
 *     test then fails on purpose. Update the docs first, then this test.
 */

const ROOT = join(__dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const READMES = ["README.md", "locales/zh-TW/README.md", "locales/zh-CN/README.md"];
const API_DOCS = ["docs/API.md", "locales/zh-TW/docs/API.md", "locales/zh-CN/docs/API.md"];

describe("docs do not promise an automatic SAGE signal source", () => {
  for (const rel of [...READMES, ...API_DOCS]) {
    it(`${rel} does not name the placeholder signal sources as defaults`, () => {
      const text = read(rel);
      // "Default: `GitHistorySignalSource`" / "預設：`..." / "默认：`..." (also fullwidth/ASCII colon, optional spaces)
      const asDefault =
        /(?:Defaults?|預設|默认|默認)\s*[:：]\s*`(?:GitHistorySignalSource|TestExitCodeSignalSource)/i;
      expect(text).not.toMatch(asDefault);
    });
  }

  for (const rel of READMES) {
    it(`${rel} defaults sentence does not list git signals`, () => {
      const text = read(rel);
      // The sentence that enumerates the out-of-the-box defaults is the one with
      // "single repo + generic markdown" (EN) / 「單一 repo + 通用 markdown」 / 「单一 repo + 通用 markdown」.
      const m = /(?:single repo|單一 repo|单一 repo)\s*\+\s*(?:generic\s+markdown|通用 markdown)[^)）」”"]*/i.exec(text);
      expect(m, `${rel}: defaults sentence not found`).not.toBeNull();
      expect(m![0]).not.toMatch(/git\s*(?:signals?|訊號|信号|信號)/i);
      // and nowhere else may it be listed as a working default
      expect(text).not.toMatch(/markdown\s*\+\s*git\s*(?:signals?|訊號|信号|信號)/i);
    });

    it(`${rel} Phase 4b line does not say "in progress"`, () => {
      const text = read(rel);
      // The Phase 4b item may span several indented continuation lines.
      const m = /^- \[[ x]\] \*\*Phase 4b\*\*[\s\S]*?(?=^- \[|\n\n)/m.exec(text);
      expect(m, `${rel}: Phase 4b item not found`).not.toBeNull();
      expect(m![0]).not.toMatch(/in progress|進行中|进行中/i);
    });

    it(`${rel} says feedback is entered by hand and no automatic source ships`, () => {
      const text = read(rel);
      expect(text).toContain("`egr feedback`");
      expect(text).toContain("`ingest_feedback`");
    });
  }

  it("claim is backed: the bundled signal sources still return no events", async () => {
    // If this fails, someone implemented a source. Re-read the tagline, the
    // defaults sentence, the "SAGE signal source" adapter item, the Phase 4b
    // line and the signal-source bullet in docs/API.md (all three languages)
    // before changing this assertion.
    expect(await new GitHistorySignalSource().collect()).toEqual([]);
    expect(await new TestExitCodeSignalSource().collect()).toEqual([]);
  });
});
