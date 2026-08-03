const MAX_HINT_SCAN_CHARS = 4_096;

const commandNotFoundName = (output: string): string | null => {
  const unix = output.match(/command not found:\s*([^\s'"`]+)/i);
  if (unix?.[1]) return unix[1];
  const bash = output.match(/:\s*([A-Za-z0-9_.-]+):\s*command not found\b/i);
  if (bash?.[1]) return bash[1];
  const shell = output.match(
    /(?:^|\n)(?:[^\n:]+:\s*)?([^\s:]+):\s*(?:not found|command not found)\b/i,
  );
  if (shell?.[1]) return shell[1];
  const windows = output.match(
    /'([^']+)' is not recognized as an internal or external command/i,
  );
  return windows?.[1] ?? null;
};

export const getTerminalRecoveryHint = (args: {
  command: string;
  exitCode: number | null;
  output: string;
}): string | null => {
  if (args.exitCode === null || args.exitCode === 0) return null;
  const output = args.output.slice(0, MAX_HINT_SCAN_CHARS);

  if (
    /CONFLICT \(|automatic merge failed|needs merge|unmerged paths/i.test(
      output,
    )
  ) {
    return "Git reported unresolved conflicts. Run `git status`, resolve the listed files, then continue; retrying the same command unchanged will fail again.";
  }

  const missingCommand = commandNotFoundName(output);
  if (missingCommand) {
    const normalized = missingCommand.toLowerCase();
    if (normalized === "python") {
      return "`python` was not found. Try the managed `python3` command; if that is also unavailable, verify Stella's managed Python toolchain before retrying.";
    }
    if (normalized === "pip") {
      return "`pip` was not found. Use `python3 -m pip` or the project's `uv` environment instead of retrying the same command.";
    }
    return `\`${missingCommand}\` was not found. Check the command name and the project or managed-tool environment before retrying; the unchanged command will fail again.`;
  }

  const missingModule = output.match(
    /(?:ModuleNotFoundError|ImportError):\s*(?:No module named\s*)?['"]?([^'"\s]+)/i,
  );
  if (missingModule?.[1]) {
    return `Python module \`${missingModule[1]}\` is unavailable in this interpreter. Use the project's virtual environment or install it through the project's \`uv\`/Python dependency workflow before retrying.`;
  }

  if (/rate limit|too many requests|HTTP\s*429/i.test(output)) {
    return "The service is rate-limiting requests. Wait for the retry window or reduce request frequency instead of immediately repeating the same command.";
  }

  if (/permission denied|operation not permitted|EACCES\b/i.test(output)) {
    return "The command lacks access to the target. Inspect the path's ownership/permissions or choose a writable target; do not retry unchanged or add elevated privileges blindly.";
  }

  if (/already exists/i.test(output)) {
    return "The target already exists. Inspect and reuse, rename, or explicitly update it; retrying the same create operation will fail again.";
  }

  if (args.exitCode === 124) {
    return "The command timed out. Inspect partial output, narrow the work, or rerun with an intentionally larger timeout.";
  }
  if (args.exitCode === 126) {
    return "The command was found but could not execute. Check that it is a valid executable and has execute permission.";
  }
  if (args.exitCode === 137) {
    return "The process was killed, commonly because it exceeded memory. Reduce its workload or memory use before retrying.";
  }

  return null;
};
