import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ExternalCli = "codex" | "claude";

type ExternalCliConfig = {
  displayName: string;
  overrideEnvNames: readonly [string, string];
  toolDirectories: readonly string[];
};

const CLI_CONFIG: Record<ExternalCli, ExternalCliConfig> = {
  codex: {
    displayName: "Codex CLI",
    overrideEnvNames: ["STELLA_CODEX_CLI_PATH", "CODEX_CLI_PATH"],
    toolDirectories: [".codex/bin", ".cargo/bin"],
  },
  claude: {
    displayName: "Claude Code CLI",
    overrideEnvNames: ["STELLA_CLAUDE_CLI_PATH", "CLAUDE_CLI_PATH"],
    toolDirectories: [".claude/local", ".claude/bin"],
  },
};

export type ResolveExternalCliOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  /** Override candidate directories for deterministic tests. */
  wellKnownDirectories?: readonly string[];
};

const resolveHomeDir = (
  env: NodeJS.ProcessEnv,
  configuredHome?: string,
): string | undefined => {
  const home =
    configuredHome?.trim() ||
    env.HOME?.trim() ||
    env.USERPROFILE?.trim() ||
    os.homedir().trim();
  return home ? path.resolve(home) : undefined;
};

const executableExtensions = (env: NodeJS.ProcessEnv): string[] => {
  if (process.platform !== "win32") return [""];
  const extensions = (env.PATHEXT ?? env.PathExt ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return ["", ...extensions];
};

const executableCandidates = (
  basePath: string,
  env: NodeJS.ProcessEnv,
): string[] => {
  if (process.platform !== "win32" || path.extname(basePath)) {
    return [basePath];
  }
  return executableExtensions(env).map((extension) =>
    extension ? `${basePath}${extension}` : basePath,
  );
};

const isExecutableFile = (candidate: string): boolean => {
  try {
    fs.accessSync(
      candidate,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
    );
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const firstExecutable = (
  basePath: string,
  env: NodeJS.ProcessEnv,
): string | null => {
  for (const candidate of executableCandidates(basePath, env)) {
    const absoluteCandidate = path.resolve(candidate);
    if (isExecutableFile(absoluteCandidate)) return absoluteCandidate;
  }
  return null;
};

const pathValue = (env: NodeJS.ProcessEnv): string => {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return pathKey ? (env[pathKey] ?? "") : "";
};

const findOnPath = (
  cli: ExternalCli,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null => {
  for (const entry of pathValue(env).split(path.delimiter)) {
    if (!entry) continue;
    const directory = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
    const executable = firstExecutable(path.join(directory, cli), env);
    if (executable) return executable;
  }
  return null;
};

const defaultWellKnownDirectories = (
  cli: ExternalCli,
  env: NodeJS.ProcessEnv,
  homeDir: string | undefined,
): string[] => {
  const directories: string[] = [];
  const add = (directory: string | undefined) => {
    if (directory) directories.push(path.resolve(directory));
  };

  if (homeDir) {
    add(path.join(homeDir, ".bun", "bin"));
    for (const relativeDirectory of CLI_CONFIG[cli].toolDirectories) {
      add(path.join(homeDir, relativeDirectory));
    }
    add(path.join(homeDir, ".local", "bin"));
    add(path.join(homeDir, ".npm-global", "bin"));
    add(path.join(homeDir, ".npm", "bin"));
    add(path.join(homeDir, ".yarn", "bin"));
    add(path.join(homeDir, ".volta", "bin"));
    add(path.join(homeDir, ".local", "share", "pnpm"));
    add(path.join(homeDir, "Library", "pnpm"));
    if (process.platform === "win32") {
      add(path.join(homeDir, "scoop", "shims"));
    }
  }

  if (process.platform === "win32") {
    add(env.APPDATA ? path.join(env.APPDATA, "npm") : undefined);
    add(
      env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")
        : undefined,
    );
  } else {
    if (process.platform === "darwin") add("/opt/homebrew/bin");
    add("/usr/local/bin");
    add("/home/linuxbrew/.linuxbrew/bin");
  }

  return [...new Set(directories)];
};

const expandConfiguredPath = (
  configuredPath: string,
  homeDir: string | undefined,
  cwd: string,
): string => {
  const expanded = homeDir
    ? configuredPath === "~"
      ? homeDir
      : /^~[\\/]/.test(configuredPath)
        ? path.join(homeDir, configuredPath.slice(2))
        : configuredPath
    : configuredPath;
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(cwd, expanded);
};

export const resolveExternalCliPath = (
  cli: ExternalCli,
  options: ResolveExternalCliOptions = {},
): string => {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const homeDir = resolveHomeDir(env, options.homeDir);
  const config = CLI_CONFIG[cli];

  for (const envName of config.overrideEnvNames) {
    const configuredPath = env[envName]?.trim();
    if (!configuredPath) continue;
    const expandedPath = expandConfiguredPath(configuredPath, homeDir, cwd);
    const executable = firstExecutable(expandedPath, env);
    if (executable) return executable;
    throw new Error(
      `${config.displayName} path from ${envName} is not an executable file: ` +
        `"${expandedPath}". Update or unset ${envName}.`,
    );
  }

  const onPath = findOnPath(cli, env, cwd);
  if (onPath) return onPath;

  const wellKnownDirectories =
    options.wellKnownDirectories?.map((directory) => path.resolve(directory)) ??
    defaultWellKnownDirectories(cli, env, homeDir);
  for (const directory of wellKnownDirectories) {
    const executable = firstExecutable(path.join(directory, cli), env);
    if (executable) return executable;
  }

  const [stellaOverride, genericOverride] = config.overrideEnvNames;
  const searched = wellKnownDirectories.map((directory) =>
    path.join(directory, cli),
  );
  throw new Error(
    `${config.displayName} executable was not found on PATH or in well-known ` +
      `install locations${searched.length ? ` (${searched.join(", ")})` : ""}. ` +
      `Install ${cli}, add it to PATH, or set ${stellaOverride} ` +
      `(or ${genericOverride}) to its absolute executable path.`,
  );
};

export const buildExternalCliChildEnv = (
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: { cliBridgeSocketPath?: string },
): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.STELLA_CLI_BRIDGE_SOCK;
  delete childEnv.STELLA_SITE_AUTH_TOKEN;
  delete childEnv.STELLA_LLM_PROXY_TOKEN;
  delete childEnv.STELLA_AUTH_TOKEN;
  if (options?.cliBridgeSocketPath) {
    childEnv.STELLA_CLI_BRIDGE_SOCK = options.cliBridgeSocketPath;
  }
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const homeDir = resolveHomeDir(env);
  const entries = [
    path.dirname(path.resolve(executablePath)),
    ...(homeDir ? [path.join(homeDir, ".bun", "bin")] : []),
    ...pathValue(env).split(path.delimiter).filter(Boolean),
  ];
  const seen = new Set<string>();
  const uniqueEntries = entries.filter((entry) => {
    const normalized =
      process.platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  childEnv[pathKey] = uniqueEntries.join(path.delimiter);
  return childEnv;
};
