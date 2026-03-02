import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { trashPathsForDeferredDelete } from "./deferred_delete.js";

type DeleteArgs = {
  force: boolean;
  targets: string[];
};

const unique = (values: string[]) => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const unquote = (value: string) => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const tokenizeListLike = (value: string) => {
  const tokens: string[] = [];
  const tokenRegex = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^,\s]+/g;
  let match = tokenRegex.exec(value);
  while (match) {
    const token = match[0]?.trim();
    if (token) {
      tokens.push(unquote(token));
    }
    match = tokenRegex.exec(value);
  }
  return tokens;
};

const parseRmArgs = (args: string[]): DeleteArgs => {
  let force = false;
  const targets: string[] = [];
  let parseOptions = true;

  for (const arg of args) {
    if (!parseOptions) {
      targets.push(arg);
      continue;
    }

    if (arg === "--") {
      parseOptions = false;
      continue;
    }

    if (arg === "-f" || arg === "--force") {
      force = true;
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      if (arg.includes("f")) {
        force = true;
      }
      continue;
    }

    targets.push(arg);
  }

  return { force, targets };
};

const parseRmdirArgs = (args: string[]): DeleteArgs => {
  const targets: string[] = [];
  let force = false;

  for (const arg of args) {
    if (arg === "--ignore-fail-on-non-empty" || arg === "-f") {
      force = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      continue;
    }
    targets.push(arg);
  }

  return { force, targets };
};

const parseUnlinkArgs = (args: string[]): DeleteArgs => {
  const targets = args.filter((arg) => !arg.startsWith("-"));
  return { force: false, targets };
};

const hasPowerShellDeleteKeyword = (command: string) =>
  /\b(?:Remove-Item|rm|del|erase|rd|rmdir)\b/i.test(command);

export const extractPowerShellDeleteTargets = (command: string) => {
  if (!hasPowerShellDeleteKeyword(command)) {
    return [];
  }

  const targets: string[] = [];
  const statementRegex =
    /\b(?:Remove-Item|rm|del|erase|rd|rmdir)\b([^;\n|]*)/gi;
  let statementMatch = statementRegex.exec(command);

  while (statementMatch) {
    const statement = statementMatch[1] ?? "";
    const pathParamRegex = /-(?:LiteralPath|Path)\s+([^;\n|]+)/gi;
    let foundParamPath = false;
    let pathMatch = pathParamRegex.exec(statement);
    while (pathMatch) {
      foundParamPath = true;
      targets.push(...tokenizeListLike(pathMatch[1] ?? ""));
      pathMatch = pathParamRegex.exec(statement);
    }

    if (!foundParamPath) {
      const tokens = tokenizeListLike(statement);
      for (const token of tokens) {
        const lowered = token.toLowerCase();
        if (
          lowered === "remove-item" ||
          lowered === "rm" ||
          lowered === "del" ||
          lowered === "erase" ||
          lowered === "rd" ||
          lowered === "rmdir" ||
          token.startsWith("-") ||
          token.startsWith("$")
        ) {
          continue;
        }
        targets.push(token);
      }
    }

    statementMatch = statementRegex.exec(command);
  }

  return unique(targets);
};

export const extractPythonDeleteTargets = (code: string) => {
  const targets: string[] = [];
  const patterns = [
    /os\.\s*(?:remove|unlink|rmdir)\s*\(\s*(['"])(.*?)\1\s*\)/g,
    /shutil\.\s*rmtree\s*\(\s*(['"])(.*?)\1\s*[,)]/g,
    /(?:pathlib\.)?Path\(\s*(['"])(.*?)\1\s*\)\s*\.\s*(?:unlink|rmdir)\s*\(/g,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(code);
    while (match) {
      const target = match[2]?.trim();
      if (target) {
        targets.push(target);
      }
      match = pattern.exec(code);
    }
  }

  return unique(targets);
};

const runPassthrough = async (binary: string, args: string[]) =>
  await new Promise<number>((resolve) => {
    const child = spawn(binary, args, {
      stdio: "inherit",
      windowsHide: false,
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });

    child.on("error", (error) => {
      console.error(`[deferred-delete] Failed to run ${binary}: ${error.message}`);
      resolve(127);
    });
  });

const handleDeleteWrapper = async (args: string[]) => {
  const cwd = args[0];
  const tool = args[1];
  const commandArgs = args.slice(2);

  if (!cwd || !tool) {
    console.error("[deferred-delete] Invalid delete wrapper arguments.");
    return 2;
  }

  let parsed: DeleteArgs;
  if (tool === "rm") {
    parsed = parseRmArgs(commandArgs);
  } else if (tool === "rmdir") {
    parsed = parseRmdirArgs(commandArgs);
  } else if (tool === "unlink") {
    parsed = parseUnlinkArgs(commandArgs);
  } else {
    console.error(`[deferred-delete] Unsupported delete tool: ${tool}`);
    return 2;
  }

  if (parsed.targets.length === 0) {
    if (parsed.force) {
      return 0;
    }
    console.error(`${tool}: missing operand`);
    return 1;
  }

  const trashResult = await trashPathsForDeferredDelete(parsed.targets, {
    cwd,
    force: parsed.force,
    source: `shell:${tool}`,
  });

  for (const error of trashResult.errors) {
    console.error(`${tool}: cannot remove '${error.path}': ${error.error}`);
  }

  if (trashResult.trashed.length > 0) {
    console.log(
      `Moved ${trashResult.trashed.length} item(s) to Stella trash (auto-delete in 24h).`,
    );
  }

  return trashResult.errors.length > 0 ? 1 : 0;
};

const findArgIndex = (args: string[], ...needles: string[]) => {
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i]?.toLowerCase();
    if (needles.includes(current)) {
      return i;
    }
  }
  return -1;
};

const handlePowerShellWrapper = async (args: string[]) => {
  const cwd = args[0];
  const executable = args[1] || "powershell";
  const psArgs = args.slice(2);
  if (!cwd) {
    console.error("[deferred-delete] Missing cwd for powershell wrapper.");
    return 2;
  }

  const commandIndex = findArgIndex(psArgs, "-command", "-c");
  if (commandIndex >= 0) {
    const commandText = psArgs[commandIndex + 1] ?? "";
    const targets = extractPowerShellDeleteTargets(commandText);
    if (targets.length > 0) {
      const force = /-force\b/i.test(commandText);
      const trashResult = await trashPathsForDeferredDelete(targets, {
        cwd,
        force,
        source: "shell:powershell",
      });

      for (const error of trashResult.errors) {
        console.error(`Remove-Item: failed to remove '${error.path}': ${error.error}`);
      }

      if (trashResult.trashed.length > 0) {
        console.log(
          `Moved ${trashResult.trashed.length} item(s) to Stella trash (auto-delete in 24h).`,
        );
      }

      return trashResult.errors.length > 0 ? 1 : 0;
    }
  }

  return runPassthrough(executable, psArgs);
};

const handlePythonWrapper = async (args: string[]) => {
  const cwd = args[0];
  const executable = args[1] || "python";
  const pyArgs = args.slice(2);
  if (!cwd) {
    console.error("[deferred-delete] Missing cwd for python wrapper.");
    return 2;
  }

  const commandIndex = findArgIndex(pyArgs, "-c");
  if (commandIndex >= 0) {
    const code = pyArgs[commandIndex + 1] ?? "";
    const targets = extractPythonDeleteTargets(code);
    if (targets.length > 0) {
      const trashResult = await trashPathsForDeferredDelete(targets, {
        cwd,
        source: "shell:python",
      });

      for (const error of trashResult.errors) {
        console.error(`python: failed to remove '${error.path}': ${error.error}`);
      }

      if (trashResult.trashed.length > 0) {
        console.log(
          `Moved ${trashResult.trashed.length} item(s) to Stella trash (auto-delete in 24h).`,
        );
      }

      return trashResult.errors.length > 0 ? 1 : 0;
    }
  }

  return runPassthrough(executable, pyArgs);
};

export const runDeferredDeleteCli = async (argv: string[]) => {
  const mode = argv[0];
  const args = argv.slice(1);

  if (mode === "delete") {
    return handleDeleteWrapper(args);
  }
  if (mode === "powershell") {
    return handlePowerShellWrapper(args);
  }
  if (mode === "python") {
    return handlePythonWrapper(args);
  }

  console.error(`[deferred-delete] Unknown mode: ${mode ?? "(missing)"}`);
  return 2;
};

const isDirectExecution = () => {
  if (!process.argv[1]) {
    return false;
  }
  const current = fileURLToPath(import.meta.url);
  const invoked = path.resolve(process.argv[1]);
  return current === invoked;
};

if (isDirectExecution()) {
  void runDeferredDeleteCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
