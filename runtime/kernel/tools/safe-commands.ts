/**
 * Curated allowlist of "obviously safe" shell commands, ported from Codex's
 * `codex-shell-command::is_safe_command::is_known_safe_command`. Single
 * source of truth for "this command is read-only, never blocks/escalates."
 *
 * Used to:
 *   - Skip HMR speculation on commands that can't possibly write source.
 *   - Provide an `is_mutating` hint for future approval/sandbox flows.
 *
 * The Rust version also handles Windows powershell prefixes; we keep this
 * Unix-first for now and add Windows when needed.
 */

const SIMPLE_SAFE_BINARIES = new Set<string>([
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

const SAFE_OPERATORS = new Set<string>(["&&", "||", ";", "|"]);

/** `bash -lc "..."` style invocations we recursively unwrap. */
const SHELL_INTERPRETERS = new Set<string>(["bash", "sh", "zsh"]);
const SHELL_LC_FLAGS = new Set<string>(["-c", "-lc", "-cl"]);

const UNSAFE_BASE64_OPTIONS = new Set<string>(["-o", "--output"]);
const UNSAFE_FIND_OPTIONS = new Set<string>([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);
const UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS = new Set<string>([
  "--search-zip",
  "-z",
]);
const UNSAFE_RIPGREP_OPTIONS_WITH_ARGS = ["--pre", "--hostname-bin"];

const UNSAFE_GIT_GLOBAL_OPTIONS = new Set<string>([
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const UNSAFE_GIT_FLAGS = new Set<string>([
  "--output",
  "--ext-diff",
  "--textconv",
  "--exec",
  "--paginate",
]);
const SAFE_GIT_SUBCOMMANDS = new Set<string>([
  "status",
  "log",
  "diff",
  "show",
  "branch",
]);
const SAFE_GIT_BRANCH_FLAGS = new Set<string>([
  "--list",
  "-l",
  "--show-current",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
]);

/**
 * Best-effort POSIX shell tokenizer. Handles single quotes, double quotes,
 * and backslash escapes; does NOT expand variables, command substitution,
 * subshells, or globs (deliberately conservative — anything more exotic
 * fails the safe check and falls through to the normal exec path).
 */
const tokenizeShell = (command: string): string[] | null => {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;
  const flushToken = () => {
    if (!hasContent) return;
    tokens.push(buf);
    buf = "";
    hasContent = false;
  };
  const pushSeparator = (token: string): boolean => {
    flushToken();
    const last = tokens[tokens.length - 1];
    if (!last || SAFE_OPERATORS.has(last)) {
      return false;
    }
    tokens.push(token);
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
        hasContent = true;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < command.length) {
        buf += command[++i]!;
        hasContent = true;
      } else {
        buf += ch;
        hasContent = true;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      buf += command[++i]!;
      hasContent = true;
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        if (!pushSeparator("&&")) return null;
        i++;
        continue;
      }
      // Backgrounding (`&`) is intentionally rejected rather than treated as a
      // separator; Codex's tree-sitter parser also rejects it for safe-command
      // classification.
      return null;
    }
    if (ch === "|") {
      if (command[i + 1] === "|") {
        if (!pushSeparator("||")) return null;
        i++;
        continue;
      }
      if (!pushSeparator("|")) return null;
      continue;
    }
    if (ch === ";") {
      if (!pushSeparator(";")) return null;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // Newlines separate commands in shell scripts, so treat them like `;`.
      if (ch === "\r" && command[i + 1] === "\n") {
        i++;
      }
      if (!pushSeparator(";")) return null;
      continue;
    }
    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }
    // Reject characters that introduce side effects we can't reason about
    // safely (subshells, redirects, command substitution, globs, etc.).
    if ("()<>`$*?[]{}".includes(ch)) {
      return null;
    }
    buf += ch;
    hasContent = true;
  }
  if (inSingle || inDouble) return null;
  flushToken();
  if (tokens.length > 0 && SAFE_OPERATORS.has(tokens[tokens.length - 1]!)) {
    return null;
  }
  return tokens;
};

const splitOnOperators = (tokens: string[]): string[][] => {
  const out: string[][] = [];
  let current: string[] = [];
  for (const tok of tokens) {
    if (SAFE_OPERATORS.has(tok)) {
      if (current.length > 0) {
        out.push(current);
        current = [];
      }
      continue;
    }
    current.push(tok);
  }
  if (current.length > 0) out.push(current);
  return out;
};

const executableLookupKey = (raw: string): string | null => {
  if (!raw) return null;
  // Strip directory components (handles `/usr/bin/git` → `git`).
  const last = raw.split(/[\\/]/).pop() ?? raw;
  // Strip `.exe` for a future Windows port.
  return last.replace(/\.exe$/i, "").toLowerCase() || null;
};

const isSafeBinaryInvocation = (cmd: string[]): boolean => {
  const head = cmd[0];
  if (!head) return false;
  // If operators leaked into the args, this is a composite (split it instead).
  if (cmd.some((arg) => SAFE_OPERATORS.has(arg))) return false;
  // Treat `zsh` as `bash` for matching, mirroring Codex.
  const lookup = executableLookupKey(head === "zsh" ? "bash" : head);
  if (!lookup) return false;

  if (SIMPLE_SAFE_BINARIES.has(lookup)) return true;

  switch (lookup) {
    case "base64":
      return !cmd.slice(1).some((arg) =>
        UNSAFE_BASE64_OPTIONS.has(arg) ||
        arg.startsWith("--output=") ||
        (arg.startsWith("-o") && arg !== "-o"),
      );
    case "find":
      return !cmd.some((arg) => UNSAFE_FIND_OPTIONS.has(arg));
    case "rg":
      return !cmd.some(
        (arg) =>
          UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS.has(arg) ||
          UNSAFE_RIPGREP_OPTIONS_WITH_ARGS.some(
            (opt) => arg === opt || arg.startsWith(`${opt}=`),
          ),
      );
    case "git":
      return isSafeGitInvocation(cmd);
    case "sed":
      return isSafeSedInvocation(cmd);
    default:
      return false;
  }
};

const gitGlobalOptionRequiresPrompt = (arg: string): boolean => {
  if (UNSAFE_GIT_GLOBAL_OPTIONS.has(arg)) return true;
  for (const opt of UNSAFE_GIT_GLOBAL_OPTIONS) {
    if (arg.startsWith(`${opt}=`)) return true;
  }
  // Codex also blocks `-ccore.pager=cat` (option fused with value, no `=`).
  if (arg.startsWith("-c") && arg !== "-c" && arg.length > 2) return true;
  return false;
};

const findGitSubcommand = (
  cmd: string[],
): { index: number; sub: string } | null => {
  // Skip global options and their values.
  let i = 1;
  while (i < cmd.length) {
    const tok = cmd[i]!;
    if (gitGlobalOptionRequiresPrompt(tok)) return null;
    // Flags that take a separate value: skip the value.
    if (
      (tok === "-C" || tok === "-c") &&
      i + 1 < cmd.length
    ) {
      i += 2;
      continue;
    }
    if (tok.startsWith("-")) {
      i += 1;
      continue;
    }
    if (SAFE_GIT_SUBCOMMANDS.has(tok)) {
      return { index: i, sub: tok };
    }
    return null;
  }
  return null;
};

const gitSubcommandArgsAreReadOnly = (args: string[]): boolean =>
  !args.some(
    (arg) =>
      UNSAFE_GIT_FLAGS.has(arg) ||
      arg.startsWith("--output=") ||
      arg.startsWith("--exec="),
  );

const gitBranchIsReadOnly = (args: string[]): boolean => {
  if (args.length === 0) return true;
  let sawReadOnly = false;
  for (const arg of args) {
    if (SAFE_GIT_BRANCH_FLAGS.has(arg) || arg.startsWith("--format=")) {
      sawReadOnly = true;
    } else {
      return false;
    }
  }
  return sawReadOnly;
};

const isSafeGitInvocation = (cmd: string[]): boolean => {
  const found = findGitSubcommand(cmd);
  if (!found) return false;
  const subArgs = cmd.slice(found.index + 1);
  if (found.sub === "branch") {
    return gitSubcommandArgsAreReadOnly(subArgs) && gitBranchIsReadOnly(subArgs);
  }
  return gitSubcommandArgsAreReadOnly(subArgs);
};

const SED_N_ARG_PATTERN = /^(\d+,)?\d+p$/;

const isSafeSedInvocation = (cmd: string[]): boolean => {
  // Only `sed -n {N|M,N}p [file]` is whitelisted (matches Codex).
  if (cmd.length > 4) return false;
  if (cmd[1] !== "-n") return false;
  const sedArg = cmd[2];
  if (!sedArg || !SED_N_ARG_PATTERN.test(sedArg)) return false;
  return true;
};

/**
 * Returns true when the command is in the curated read-only allowlist.
 *
 * Accepts either a string (parsed with our conservative tokenizer) or an
 * argv array (when callers already have one). Composite expressions joined
 * with `&&`, `||`, `;`, or `|` are allowed only when *every* child command
 * is itself safe.
 */
export const isKnownSafeCommand = (command: string | string[]): boolean => {
  const tokens = Array.isArray(command) ? command : tokenizeShell(command);
  if (!tokens || tokens.length === 0) return false;

  // `bash -lc "real command"` → recurse on the inner string.
  const head = executableLookupKey(tokens[0]!);
  if (
    head &&
    SHELL_INTERPRETERS.has(head) &&
    tokens.length === 3 &&
    SHELL_LC_FLAGS.has(tokens[1]!)
  ) {
    return isKnownSafeCommand(tokens[2]!);
  }

  if (isSafeBinaryInvocation(tokens)) return true;

  // Composite case: split on safe operators, every piece must be safe.
  const pieces = splitOnOperators(tokens);
  if (pieces.length > 1 && pieces.every((piece) => isSafeBinaryInvocation(piece))) {
    return true;
  }
  return false;
};
