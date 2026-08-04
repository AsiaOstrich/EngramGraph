/**
 * Post-install notice: how to register the MCP server.
 * // implements XSPEC-365 R7
 *
 * **Why this exists.** Installing the package puts `egr` and `egr-mcp` on
 * PATH, but the MCP server does nothing until a coding assistant is told to
 * spawn it — and nothing in the install output said so. Half of what this
 * package is for was reachable only by finding the right section of the
 * README, which is a poor place to discover that a feature exists at all.
 *
 * **Why it can't just register itself.** There is no npm hook that could do
 * it, and there should not be: a package that writes itself into your coding
 * assistant's tool configuration during `npm install` has granted itself tool
 * access without being asked. Registration is a decision the user makes, so
 * the most an installer should do is say which command to run.
 *
 * **Why only on a global install.** `npm_config_global` is `"true"` for
 * `npm install -g` and unset when the package is a dependency of someone
 * else's project (measured, not assumed). Someone who added `engramgraph` to
 * their own app's dependencies is using the embedded API; telling them to wire
 * up an AI assistant is noise in a build log they did not ask for.
 */

const DOCS = "https://github.com/AsiaOstrich/EngramGraph/blob/main/docs/MCP.md";

/**
 * Whether the notice should be shown, given an environment.
 *
 * Takes `env` rather than reading `process.env` so the decision is testable
 * without an install: this is the part that decides whether thousands of CI
 * build logs get an unwanted banner, and "we'll find out in production" is a
 * poor way to settle that.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function shouldShowNotice(env = process.env) {
  return env.npm_config_global === "true";
}

export const NOTICE = `
engramgraph installed. Two ways to use it:

  1. CLI          egr index ./src   then   egr callers <symbol>
  2. MCP server   let a coding assistant read and update the graph

The MCP server is not registered automatically — no npm package should write
itself into your assistant's tool configuration. One command does it:

  claude mcp add egr -- npx egr-mcp

Then check it took: claude mcp list  →  egr … ✓ Connected

Codex / Cursor / Windsurf and the full tool list: ${DOCS}
`;

/** Only speak when run as the install hook, so importing this stays silent. */
const RUN_AS_HOOK = process.argv[1]?.endsWith("postinstall.js") ?? false;

if (RUN_AS_HOOK && shouldShowNotice()) {
  // A notice that breaks the install would be worse than no notice.
  try {
    console.log(NOTICE);
  } catch {
    /* nothing here is worth failing an install over */
  }
}
