/**
 * Per-agent allowlist for the install-update agent's `exec_command` tool.
 *
 * The install-update agent runs `git merge` against attached upstream
 * history (see `runtime/extensions/stella-runtime/agents/install_update.md`)
 * and otherwise inspects the repo. It does NOT need general bash access,
 * so we restrict every command it can run to a narrow `git`-only allowlist
 * — even though `isDangerousCommand` already blocks the worst patterns
 * globally, that's a blocklist; this is a defense-in-depth allowlist that
 * keeps the agent inside its lane.
 *
 * Returns `null` if the command is allowed for `install_update`,
 * or a human-readable denial reason otherwise.
 */

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  // Mutating, but bounded to merge mechanics
  "fetch",
  "merge",
  "add",
  "commit",
  // Read-only inspection
  "status",
  "diff",
  "show",
  "log",
  "ls-tree",
  "rev-parse",
  "cat-file",
  "ls-files",
  "config",
]);

/**
 * Flags banned anywhere in the tokenized command, regardless of the
 * subcommand. These are flags whose only purpose is destructive in our
 * context — `--force` and `--mirror` would either rewrite local refs
 * or push to a remote we don't intend to touch.
 */
const BANNED_FLAGS = new Set([
  "--force",
  "-f", // git push -f, etc.
  "--mirror",
]);

/**
 * `git config` is allowed only for read access (`git config --get …` /
 * `git config --get-all …`) — the agent can need this to inspect remote
 * URLs, user.name, etc., but mustn't rewrite anything in `.git/config`.
 */
const ALLOWED_GIT_CONFIG_MODES = new Set(["--get", "--get-all", "--list", "-l", "--get-regexp"]);

/**
 * Tokenize a command line, collapsing whitespace. Quoting is intentionally
 * not honored — the agent's allowed commands have no need for quoted
 * arguments containing flag-like substrings, and this is a defense-in-depth
 * gate, so a paranoid scan of every whitespace-split token is correct.
 */
const tokenize = (command: string): string[] =>
  command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

/**
 * Check whether the install-update agent is allowed to run `command`.
 * Returns `null` when allowed, or a denial reason when not.
 */
export const getInstallUpdateCommandDenialReason = (
  command: string,
): string | null => {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return "install_update: command is empty.";
  }

  // Block compound commands (&&, ||, ;, |, &, backticks, $(...))
  // even before tokenizing — a single shell layer must execute exactly one
  // git invocation. This catches `git status && rm -rf /` patterns up front.
  if (/[;&|`]|\$\(/.test(trimmed)) {
    return "install_update: command must be a single git invocation (no shell composition).";
  }

  const tokens = tokenize(trimmed);
  if (tokens[0] !== "git") {
    return "install_update: only git commands are allowed.";
  }

  // Find the actual subcommand by skipping `-c key=value`, `--git-dir=…`,
  // `--work-tree=…`, etc. that may appear before the subcommand.
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "-c" || t === "-C") {
      i += 2;
      continue;
    }
    if (
      t.startsWith("--git-dir=") ||
      t.startsWith("--work-tree=") ||
      t.startsWith("--namespace=") ||
      t.startsWith("--config-env=")
    ) {
      i += 1;
      continue;
    }
    if (t === "--git-dir" || t === "--work-tree" || t === "--namespace") {
      i += 2;
      continue;
    }
    break;
  }

  const subcommand = tokens[i];
  if (!subcommand) {
    return "install_update: missing git subcommand.";
  }
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    return `install_update: 'git ${subcommand}' is not allowed (allowed: ${Array.from(
      ALLOWED_GIT_SUBCOMMANDS,
    ).join(", ")}).`;
  }

  // Banned flag scan, applied to everything after the subcommand.
  const argTokens = tokens.slice(i + 1);
  for (const banned of BANNED_FLAGS) {
    if (argTokens.includes(banned)) {
      return `install_update: flag '${banned}' is not allowed for git ${subcommand}.`;
    }
  }

  // `git config` must be read-only.
  if (subcommand === "config") {
    const hasReadFlag = argTokens.some((t) => ALLOWED_GIT_CONFIG_MODES.has(t));
    if (!hasReadFlag) {
      return "install_update: 'git config' is allowed only with read flags (--get / --get-all / --list / --get-regexp).";
    }
  }

  // `git fetch` must target `origin` — never an arbitrary remote URL or
  // alternate name. The agent's job is bounded to the repo it was installed
  // from. Allow `git fetch` (no args) too, which fetches from the
  // default-tracked remote (origin in our setup).
  if (subcommand === "fetch") {
    // If there's any positional that looks like a remote (not a flag),
    // it must be `origin`. Skip flag-shaped args entirely.
    const positionals = argTokens.filter((t) => !t.startsWith("-"));
    if (positionals.length > 0 && positionals[0] !== "origin") {
      return "install_update: 'git fetch' may only target 'origin'.";
    }
  }

  return null;
};
