import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import type {
  DevEnvironmentSignals,
  IDEExtension,
  IDESettings,
  GitConfig,
} from "./discovery_types.js";

const log = (...args: unknown[]) => console.log("[dev-environment]", ...args);

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

const execAsync = (command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(command, { encoding: "utf-8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });

async function collectIDEExtensions(): Promise<IDEExtension[]> {
  const extensions: IDEExtension[] = [];
  const homeDir = os.homedir();

  const vscodeExtDir = path.join(homeDir, ".vscode", "extensions");
  const cursorExtDir = path.join(homeDir, ".cursor", "extensions");

  const readExtensions = async (dir: string, source: "vscode" | "cursor") => {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        // Strip version suffix: take everything before the last "-" followed by digits/dots only
        const match = entry.match(/^(.+)-[\d.]+$/);
        const name = match ? match[1] : entry;
        extensions.push({ name, source });
      }
    } catch (err) {
      // Directory doesn't exist, ignore
    }
  };

  await Promise.all([
    readExtensions(vscodeExtDir, "vscode"),
    readExtensions(cursorExtDir, "cursor"),
  ]);

  return extensions;
}

async function collectIDESettings(): Promise<IDESettings[]> {
  const settings: IDESettings[] = [];
  const homeDir = os.homedir();
  const platform = process.platform;

  const extractedKeys = [
    "workbench.colorTheme",
    "editor.fontFamily",
    "editor.fontSize",
    "editor.formatOnSave",
    "editor.tabSize",
    "editor.defaultFormatter",
    `terminal.integrated.defaultProfile.${platform === "darwin" ? "osx" : platform === "win32" ? "windows" : "linux"}`,
  ];

  const getSettingsPath = (ide: "vscode" | "cursor") => {
    const baseName = ide === "vscode" ? "Code" : "Cursor";
    if (platform === "darwin") {
      return path.join(homeDir, "Library", "Application Support", baseName, "User", "settings.json");
    } else if (platform === "win32") {
      return path.join(process.env.APPDATA || "", baseName, "User", "settings.json");
    } else {
      return path.join(homeDir, ".config", baseName, "User", "settings.json");
    }
  };

  const readSettings = async (source: "vscode" | "cursor") => {
    try {
      const settingsPath = getSettingsPath(source);
      const content = await fs.readFile(settingsPath, "utf-8");
      const parsed = JSON.parse(content);
      const highlights: Record<string, string> = {};

      for (const key of extractedKeys) {
        if (key in parsed) {
          highlights[key] = String(parsed[key]);
        }
      }

      if (Object.keys(highlights).length > 0) {
        settings.push({ source, highlights });
      }
    } catch (err) {
      // File doesn't exist or can't be parsed, ignore
    }
  };

  await Promise.all([readSettings("vscode"), readSettings("cursor")]);

  return settings;
}

async function collectGitConfig(): Promise<GitConfig | null> {
  const homeDir = os.homedir();
  const gitConfigPath = path.join(homeDir, ".gitconfig");

  try {
    const content = await fs.readFile(gitConfigPath, "utf-8");
    if (!content.trim()) {
      return null;
    }

    const config: GitConfig = {
      name: undefined,
      email: undefined,
      defaultBranch: undefined,
      aliases: [],
    };

    let currentSection = "";
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      // Section header
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        continue;
      }

      // Key-value pair
      const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;

        if (currentSection === "user") {
          if (key === "name") config.name = value;
          if (key === "email") config.email = value;
        } else if (currentSection === "init") {
          if (key === "defaultBranch") config.defaultBranch = value;
        } else if (currentSection === "alias") {
          config.aliases.push(key);
        }
      }
    }

    return config;
  } catch (err) {
    return null;
  }
}

async function collectDotfiles(): Promise<string[]> {
  const homeDir = os.homedir();
  const dotfilesToCheck = [
    ".zshrc",
    ".bashrc",
    ".bash_profile",
    ".profile",
    ".vimrc",
    ".nvimrc",
    ".tmux.conf",
    ".npmrc",
    ".yarnrc.yml",
    ".editorconfig",
    ".prettierrc",
    ".prettierrc.json",
    ".eslintrc",
    ".eslintrc.json",
    ".wezterm.lua",
    ".alacritty.yml",
    ".alacritty.toml",
    ".hyper.js",
    ".starship.toml",
  ];

  const existing: string[] = [];

  await Promise.all(
    dotfilesToCheck.map(async (file) => {
      try {
        await fs.access(path.join(homeDir, file));
        existing.push(file);
      } catch (err) {
        // File doesn't exist, ignore
      }
    })
  );

  return existing;
}

async function collectRuntimes(): Promise<string[]> {
  const homeDir = os.homedir();
  const runtimesToCheck = [
    { dir: ".nvm", name: "nvm" },
    { dir: ".pyenv", name: "pyenv" },
    { dir: ".rustup", name: "rustup" },
    { dir: ".sdkman", name: "sdkman" },
    { dir: ".rbenv", name: "rbenv" },
    { dir: ".goenv", name: "goenv" },
    { dir: ".volta", name: "volta" },
    { dir: ".cargo", name: "cargo" },
    { dir: ".deno", name: "deno" },
    { dir: path.join(".local", "share", "mise"), name: "mise" },
  ];

  const detected: string[] = [];

  await Promise.all(
    runtimesToCheck.map(async ({ dir, name }) => {
      try {
        await fs.access(path.join(homeDir, dir));
        detected.push(name);
      } catch (err) {
        // Directory doesn't exist, ignore
      }
    })
  );

  return detected;
}

async function collectPackageManagers(): Promise<string[]> {
  const homeDir = os.homedir();
  const platform = process.platform;
  const detected: string[] = [];

  const checks: Promise<void>[] = [];

  // Homebrew (macOS)
  if (platform === "darwin") {
    checks.push(
      (async () => {
        try {
          await fs.access("/opt/homebrew");
          detected.push("homebrew");
          return;
        } catch (err) {
          // Try alternate location
        }
        try {
          await fs.access("/usr/local/Homebrew");
          detected.push("homebrew");
        } catch (err) {
          // Not found
        }
      })()
    );
  }

  // Scoop and Chocolatey (Windows)
  if (platform === "win32") {
    checks.push(
      (async () => {
        try {
          await fs.access(path.join(homeDir, "scoop"));
          detected.push("scoop");
        } catch (err) {
          // Not found
        }
      })()
    );

    checks.push(
      (async () => {
        try {
          const programData = process.env.ProgramData || "C:\\ProgramData";
          await fs.access(path.join(programData, "chocolatey"));
          detected.push("chocolatey");
        } catch (err) {
          // Not found
        }
      })()
    );

    checks.push(
      (async () => {
        try {
          await execAsync("where winget");
          detected.push("winget");
        } catch {
          // Not found
        }
      })()
    );
  }

  // pnpm (cross-platform)
  checks.push(
    (async () => {
      const pnpmPaths =
        platform === "win32"
          ? [path.join(process.env.LOCALAPPDATA || "", "pnpm")]
          : [path.join(homeDir, ".local", "share", "pnpm")];

      for (const pnpmPath of pnpmPaths) {
        try {
          await fs.access(pnpmPath);
          detected.push("pnpm");
          return;
        } catch (err) {
          // Try next path
        }
      }
    })()
  );

  await Promise.all(checks);

  return Array.from(new Set(detected));
}

async function detectWSL(): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  try {
    const localAppData = process.env.LOCALAPPDATA || "";
    const packagesDir = path.join(localAppData, "Packages");
    const entries = await fs.readdir(packagesDir);

    return entries.some((entry) => entry.startsWith("CanonicalGroupLimited"));
  } catch (err) {
    return false;
  }
}

export async function collectDevEnvironment(): Promise<DevEnvironmentSignals> {
  const [ideExtensions, ideSettings, gitConfig, dotfiles, runtimes, packageManagers, wslDetected] =
    await Promise.all([
      withTimeout(collectIDEExtensions(), 5000, []),
      withTimeout(collectIDESettings(), 3000, []),
      withTimeout(collectGitConfig(), 2000, null),
      withTimeout(collectDotfiles(), 2000, []),
      withTimeout(collectRuntimes(), 2000, []),
      withTimeout(collectPackageManagers(), 2000, []),
      withTimeout(detectWSL(), 3000, false),
    ]);

  return {
    ideExtensions,
    ideSettings,
    gitConfig,
    dotfiles,
    runtimes,
    packageManagers,
    wslDetected,
  };
}

export function formatDevEnvironmentForSynthesis(data: DevEnvironmentSignals): string {
  const sections: string[] = [];

  // IDE Extensions
  if (data.ideExtensions.length > 0) {
    const vscodeExts = data.ideExtensions.filter((e) => e.source === "vscode");
    const cursorExts = data.ideExtensions.filter((e) => e.source === "cursor");

    const lines: string[] = ["### IDE Extensions"];

    if (vscodeExts.length > 0) {
      const names = vscodeExts.slice(0, 20).map((e) => e.name);
      lines.push(`VSCode (${vscodeExts.length}): ${names.join(", ")}`);
    }

    if (cursorExts.length > 0) {
      const names = cursorExts.slice(0, 20).map((e) => e.name);
      lines.push(`Cursor (${cursorExts.length}): ${names.join(", ")}`);
    }

    sections.push(lines.join("\n"));
  }

  // IDE Settings
  if (data.ideSettings.length > 0) {
    const lines: string[] = ["### IDE Settings"];

    for (const setting of data.ideSettings) {
      for (const [key, value] of Object.entries(setting.highlights)) {
        lines.push(`${setting.source}: ${key}: ${JSON.stringify(value)}`);
      }
    }

    sections.push(lines.join("\n"));
  }

  // Git Identity
  if (data.gitConfig) {
    const lines: string[] = ["### Git Identity"];
    const parts: string[] = [];

    if (data.gitConfig.name) parts.push(`Name: ${data.gitConfig.name}`);
    if (data.gitConfig.email) parts.push(`Email: ${data.gitConfig.email}`);
    if (data.gitConfig.defaultBranch) parts.push(`Default Branch: ${data.gitConfig.defaultBranch}`);

    if (parts.length > 0) {
      lines.push(parts.join(", "));
    }

    if (data.gitConfig.aliases.length > 0) {
      lines.push(`Aliases: ${data.gitConfig.aliases.join(", ")}`);
    }

    if (lines.length > 1) {
      sections.push(lines.join("\n"));
    }
  }

  // Dotfiles
  if (data.dotfiles.length > 0) {
    sections.push(`### Dotfiles\n${data.dotfiles.join(", ")}`);
  }

  // Runtimes
  if (data.runtimes.length > 0) {
    sections.push(`### Runtimes\n${data.runtimes.join(", ")}`);
  }

  // Package Managers
  if (data.packageManagers.length > 0) {
    sections.push(`### Package Managers\n${data.packageManagers.join(", ")}`);
  }

  // WSL
  if (data.wslDetected) {
    sections.push("### WSL\nDetected");
  }

  if (sections.length === 0) {
    return "";
  }

  return `## Development Environment\n${sections.join("\n")}`;
}
