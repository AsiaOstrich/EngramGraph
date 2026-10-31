// implements DEC-140
/**
 * The status line a document writes in its own opening section, for the documents
 * whose status is not in front matter (dev-platform writes `> **狀態**: Implemented`
 * under the title, in 400+ files).
 *
 * Read by `egr lint` only. It is NOT stored on any node: a Spec node's `status` is
 * still the front-matter field, so `egr index` and the graph schema are unchanged.
 *
 * ## Which line counts
 *
 * The FIRST match in the opening section: everything before the first level-2
 * heading (`## `). A body quotes statuses all the time ("the earlier plan was
 * `**狀態**: Superseded`"), and a line further down is about something else. Lines
 * inside a fenced code block are skipped, and a `## ` inside one does not end the
 * section.
 *
 * Shapes read (the label is `狀態`, `状态` or `Status`, bold; the colon is `:` or `：`):
 *   `> **狀態**: X`   `**狀態**：X`   `- **Status**: X`   `> - **狀態**: X`   `| **狀態** | X |`
 * The value loses leading symbols (an emoji, a backtick, `⚠️`) and every `**`, and keeps the rest,
 * qualifier included: `✅ **Implemented** v1` -> `Implemented v1`, `Superseded（被 X 取代）` stays whole.
 */

const LABEL = String.raw`\*\*(?:狀態|状态|Status)\*\*`;
const LINE = new RegExp(String.raw`^\s*(?:>\s*)*(?:[-*+]\s+)?${LABEL}\s*[:：]\s*(.+?)\s*$`);
const ROW = new RegExp(String.raw`^\s*\|\s*${LABEL}\s*\|\s*(.+?)\s*\|?\s*$`);

/** Drop leading symbols (emoji, `*`, backticks, brackets) so the value starts at its first letter or digit. */
function cleanValue(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\*\*/g, "").trim();
}

/** The status written in the opening section of `body`, or `undefined` when there is none. */
export function readBodyStatus(body: string): string | undefined {
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s/.test(line)) return undefined; // the opening section ends at the first level-2 heading
    const m = LINE.exec(line) ?? ROW.exec(line);
    if (m) {
      const v = cleanValue(m[1] ?? "");
      if (v !== "") return v;
    }
  }
  return undefined;
}
