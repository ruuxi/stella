import { createWriteStream, promises as fs } from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { resolveDefaultStellaHomePath } from "../home/stella-home.js";
import type { ToolContext } from "./types.js";

const RIPGREP_VERSION = "15.1.0";

const PLATFORM = {
  "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
  "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
  "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
  "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
  "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
  "ia32-win32": { platform: "i686-pc-windows-msvc", extension: "zip" },
  "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
} as const;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedRipgrepPath: string | null = null;
let pendingResolve: Promise<string | null> | null = null;

const executableName = () => (process.platform === "win32" ? "rg.exe" : "rg");

const isExecutableFile = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(
      filePath,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
    );
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const pathEntries = (): string[] => {
  const rawPath = process.env.PATH ?? process.env.Path ?? "";
  return rawPath.split(path.delimiter).filter(Boolean);
};

const pathExts = (): string[] => {
  if (process.platform !== "win32") return [""];
  const raw =
    process.env.PATHEXT ?? process.env.PathExt ?? ".EXE;.CMD;.BAT;.COM";
  return raw.split(";").filter(Boolean);
};

const findOnPath = async (): Promise<string | null> => {
  const name = executableName();
  for (const entry of pathEntries()) {
    const direct = path.join(entry, name);
    if (await isExecutableFile(direct)) return direct;
    if (process.platform !== "win32" || path.extname(name)) continue;
    for (const ext of pathExts()) {
      const candidate = path.join(entry, `${name}${ext.toLowerCase()}`);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
};

const resolveStellaBinDir = (context?: ToolContext): string => {
  const stellaHome =
    context?.stellaHome?.trim() ||
    process.env.STELLA_HOME?.trim() ||
    resolveDefaultStellaHomePath();
  return path.join(path.resolve(stellaHome), "bin");
};

const bundledCandidates = (context?: ToolContext): string[] => {
  const platformPackage = `sdk-${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;
  const roots = [
    context?.stellaRoot,
    process.env.STELLA_ROOT,
    path.resolve(__dirname, "..", "..", ".."),
  ].filter((entry): entry is string => Boolean(entry?.trim()));
  return roots.flatMap((root) => [
    path.join(root, "node_modules", ".bin", executableName()),
    path.join(
      root,
      "node_modules",
      "@cursor",
      platformPackage,
      "bin",
      executableName(),
    ),
    path.join(root, "resources", "bin", executableName()),
    path.join(root, "bin", executableName()),
  ]);
};

const copyBundledRipgrep = async (
  target: string,
  context?: ToolContext,
): Promise<string | null> => {
  for (const candidate of bundledCandidates(context)) {
    if (!(await isExecutableFile(candidate))) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(candidate, target);
    if (process.platform !== "win32") await fs.chmod(target, 0o755);
    return target;
  }
  return null;
};

const runProcess = async (
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });

const downloadRipgrep = async (target: string): Promise<string | null> => {
  const platformKey =
    `${process.arch}-${process.platform}` as keyof typeof PLATFORM;
  const config = PLATFORM[platformKey];
  if (!config) return null;

  const filename = `ripgrep-${RIPGREP_VERSION}-${config.platform}.${config.extension}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${filename}`;
  const binDir = path.dirname(target);
  const archive = path.join(binDir, filename);
  const extractDir = path.join(
    binDir,
    `ripgrep-${RIPGREP_VERSION}-${Date.now()}`,
  );

  await fs.mkdir(extractDir, { recursive: true });
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) return null;
    await pipeline(
      // Node's fetch body is a web stream; pipeline accepts it in supported runtimes.
      response.body as unknown as NodeJS.ReadableStream,
      createWriteStream(archive),
    );

    if (config.extension === "zip") {
      const shell =
        (await findCommand("powershell.exe")) ??
        (await findCommand("pwsh.exe")) ??
        "powershell.exe";
      const result = await runProcess(shell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`,
      ]);
      if (result.code !== 0) return null;
    } else {
      const result = await runProcess("tar", [
        "-xzf",
        archive,
        "-C",
        extractDir,
      ]);
      if (result.code !== 0) return null;
    }

    const extracted = path.join(
      extractDir,
      `ripgrep-${RIPGREP_VERSION}-${config.platform}`,
      executableName(),
    );
    if (!(await isExecutableFile(extracted))) return null;
    await fs.copyFile(extracted, target);
    if (process.platform !== "win32") await fs.chmod(target, 0o755);
    return target;
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {});
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
};

const findCommand = async (command: string): Promise<string | null> => {
  for (const entry of pathEntries()) {
    const candidate = path.join(entry, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
};

export const resolveRipgrepPath = async (
  context?: ToolContext,
): Promise<string | null> => {
  if (cachedRipgrepPath && (await isExecutableFile(cachedRipgrepPath))) {
    return cachedRipgrepPath;
  }
  if (pendingResolve) return pendingResolve;

  pendingResolve = (async () => {
    const system = await findOnPath();
    if (system) return system;

    const target = path.join(resolveStellaBinDir(context), executableName());
    if (await isExecutableFile(target)) return target;

    const bundled = await copyBundledRipgrep(target, context);
    if (bundled) return bundled;

    return await downloadRipgrep(target);
  })();

  try {
    cachedRipgrepPath = await pendingResolve;
    return cachedRipgrepPath;
  } finally {
    pendingResolve = null;
  }
};

export const clearRipgrepPathCacheForTests = () => {
  cachedRipgrepPath = null;
  pendingResolve = null;
};
