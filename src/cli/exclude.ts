// implements XSPEC-457
/**
 * `egr index --exclude <glob>` — user-supplied paths the walk must not enter
 * (XSPEC-457 R5).
 *
 * The built-in skip list (`SKIP_DIRS` in walk.ts) names directories by exact
 * name and covers `.git` and `.engram` among the dot-directories, nothing else.
 * A project that keeps `.uds-backup-*` beside its sources therefore had about
 * a hundred backup Markdown files counted into its documents with no way to
 * say otherwise — and `.gitignore` is deliberately not read.
 *
 * ## Pattern language (small on purpose, documented in `--help`)
 *
 *   `*`   any run of characters except `/`
 *   `**`  any run of characters including `/` (`**` + `/` also matches zero directories)
 *   `?`   exactly one character except `/`
 *   `{a,b}`  either alternative (not nested)
 *   `[abc]`  one of the listed characters
 *
 * Matching is against the path RELATIVE to the index root, `/`-separated on
 * every platform:
 *
 *   - a pattern with no `/` matches an entry's NAME at any depth
 *     (`.uds-backup-*` excludes `./.uds-backup-1/` and `./pkg/.uds-backup-2/`);
 *   - a pattern with a `/` at the START or in the MIDDLE is anchored at the root
 *     and must match the whole relative path (`docs/archive/**`, `src/generated`,
 *     `/logs`);
 *   - a trailing `/` restricts the pattern to directories and does NOT anchor
 *     it: `logs/` excludes `logs` and `api/logs` alike, because the trailing
 *     slash is removed before the "does it contain a /" question is asked (found
 *     by a consumer, XSPEC-476 R3: the help said the opposite). `/logs/` is the
 *     anchored form. A leading `./` is dropped the same way, so `./logs/` is not
 *     anchored either;
 *   - excluding a directory excludes everything under it.
 */

export interface ExcludeMatcher {
  /** The patterns as given, for echoing back in the summary. */
  readonly patterns: readonly string[];
  /** Whether the entry at `relPath` (POSIX, relative to the root) is excluded. */
  matches(relPath: string, name: string, isDir: boolean): boolean;
  /**
   * For each pattern, in the order given, whether it matches the entry —
   * every pattern is asked, not just up to the first that says yes, so an entry
   * two patterns both cover is counted for both (XSPEC-476 R3).
   */
  matchEach(relPath: string, name: string, isDir: boolean): boolean[];
}

function globToRegexSource(glob: string): string {
  let out = "";
  let inBrace = false;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      inBrace = true;
      out += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace = false;
      out += ")";
    } else if (c === "," && inBrace) {
      out += "|";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        out += `[${glob.slice(i + 1, end).replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else {
      out += c.replace(/[.+^$()|\\/]/g, "\\$&");
    }
  }
  if (inBrace) throw new Error(`--exclude: unclosed "{" in pattern "${glob}"`);
  return out;
}

interface Compiled {
  re: RegExp;
  anchored: boolean;
  dirOnly: boolean;
}

function hit(c: Compiled, relPath: string, name: string, isDir: boolean): boolean {
  return (!c.dirOnly || isDir) && c.re.test(c.anchored ? relPath : name);
}

/** Compile `--exclude` patterns. Throws on an empty or malformed pattern — a silently ignored pattern is a silently wrong index. */
export function compileExcludes(patterns: readonly string[]): ExcludeMatcher {
  const compiled: Compiled[] = patterns.map((raw) => {
    let p = raw.trim().replace(/\\/g, "/");
    if (p === "") throw new Error(`--exclude needs a non-empty glob (got "${raw}")`);
    const dirOnly = p.endsWith("/");
    p = p.replace(/\/+$/, "").replace(/^\.\//, "");
    const anchored = p.startsWith("/") || p.includes("/");
    p = p.replace(/^\/+/, "");
    if (p === "") throw new Error(`--exclude pattern "${raw}" has nothing left to match`);
    return { re: new RegExp(`^${globToRegexSource(p)}$`), anchored, dirOnly };
  });
  return {
    patterns: [...patterns],
    matches(relPath, name, isDir) {
      return compiled.some((c) => hit(c, relPath, name, isDir));
    },
    matchEach(relPath, name, isDir) {
      return compiled.map((c) => hit(c, relPath, name, isDir));
    },
  };
}
