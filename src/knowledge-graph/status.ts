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
 * Shapes read (the label is `狀態`, `状态` or `Status`; the colon is `:` or `：`):
 *   bold, with a colon:  `> **狀態**: X`   `**狀態**：X`   `- **Status**: X`   `> - **狀態**: X`
 *   a table row:         `| **狀態** | X |`   and, not bold, `| 狀態 | X |`   `| Status | X |`
 * A plain label is read ONLY as the first cell of a table row (issue #24: a "field | value" spec template
 * writes `| 狀態 | Approved |`). The strictness above is why it is not wider: a plain `狀態: Superseded` in
 * prose ("the earlier plan was 狀態: Superseded") is still not a status, and neither is a table cell that
 * merely contains the word (`| 狀態說明 | X |`, `| 專案狀態 | X |`). A plain row that is the HEADER of its
 * table (the next line is the `|---|---|` separator, as in `| Status | Meaning |`) names a column, not a
 * value, and is skipped.
 * The value loses leading symbols (an emoji, a backtick, `⚠️`) and every `**`, and keeps the rest,
 * qualifier included: `✅ **Implemented** v1` -> `Implemented v1`, `Superseded（被 X 取代）` stays whole.
 */

const LABEL = String.raw`\*\*(?:狀態|状态|Status)\*\*`;
const LINE = new RegExp(String.raw`^\s*(?:>\s*)*(?:[-*+]\s+)?${LABEL}\s*[:：]\s*(.+?)\s*$`);
const ROW = new RegExp(String.raw`^\s*\|\s*${LABEL}\s*\|\s*(.+?)\s*\|?\s*$`);
/** `| 狀態 | X |`: the same row without bold. The label must be the whole first cell. (issue #24) */
const PLAIN_ROW = /^\s*\|\s*(?:狀態|状态|Status)\s*\|\s*(.+?)\s*\|?\s*$/;
/** The `|---|---|` line under a table header. */
const SEPARATOR = /^(?=.*\|)\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Drop leading symbols (emoji, `*`, backticks, brackets) so the value starts at its first letter or digit. */
function cleanValue(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\*\*/g, "").trim();
}

/** The status written in the opening section of `body`, or `undefined` when there is none. */
export function readBodyStatus(body: string): string | undefined {
  let inFence = false;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s/.test(line)) return undefined; // the opening section ends at the first level-2 heading
    let m = LINE.exec(line) ?? ROW.exec(line);
    // A plain row followed by the separator line is a table header (`| Status | Meaning |`), not a value.
    if (!m && !SEPARATOR.test(lines[i + 1] ?? "x")) m = PLAIN_ROW.exec(line);
    if (m) {
      const v = cleanValue(m[1] ?? "");
      if (v !== "") return v;
    }
  }
  return undefined;
}
