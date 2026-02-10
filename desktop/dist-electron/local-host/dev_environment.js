import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
const withTimeout = (promise, ms, fallback) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
const execAsync = (command) => new Promise((resolve, reject) => {
    exec(command, { encoding: "utf-8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
            reject(error);
            return;
        }
        resolve(stdout.trim());
    });
});
async function collectGitConfig() {
    const homeDir = os.homedir();
    const gitConfigPath = path.join(homeDir, ".gitconfig");
    try {
        const content = await fs.readFile(gitConfigPath, "utf-8");
        if (!content.trim()) {
            return null;
        }
        const config = {
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
                    if (key === "name")
                        config.name = value;
                    if (key === "email")
                        config.email = value;
                }
                else if (currentSection === "init") {
                    if (key === "defaultBranch")
                        config.defaultBranch = value;
                }
                else if (currentSection === "alias") {
                    config.aliases.push(key);
                }
            }
        }
        return config;
    }
    catch {
        return null;
    }
}
async function collectDotfiles() {
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
    const existing = [];
    await Promise.all(dotfilesToCheck.map(async (file) => {
        try {
            await fs.access(path.join(homeDir, file));
            existing.push(file);
        }
        catch {
            // File doesn't exist, ignore
        }
    }));
    return existing;
}
async function collectRuntimes() {
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
    const detected = [];
    await Promise.all(runtimesToCheck.map(async ({ dir, name }) => {
        try {
            await fs.access(path.join(homeDir, dir));
            detected.push(name);
        }
        catch {
            // Directory doesn't exist, ignore
        }
    }));
    return detected;
}
async function collectPackageManagers() {
    const homeDir = os.homedir();
    const platform = process.platform;
    const detected = [];
    const checks = [];
    // Homebrew (macOS)
    if (platform === "darwin") {
        checks.push((async () => {
            try {
                await fs.access("/opt/homebrew");
                detected.push("homebrew");
                return;
            }
            catch {
                // Try alternate location
            }
            try {
                await fs.access("/usr/local/Homebrew");
                detected.push("homebrew");
            }
            catch {
                // Not found
            }
        })());
    }
    // Scoop and Chocolatey (Windows)
    if (platform === "win32") {
        checks.push((async () => {
            try {
                await fs.access(path.join(homeDir, "scoop"));
                detected.push("scoop");
            }
            catch {
                // Not found
            }
        })());
        checks.push((async () => {
            try {
                const programData = process.env.ProgramData || "C:\\ProgramData";
                await fs.access(path.join(programData, "chocolatey"));
                detected.push("chocolatey");
            }
            catch {
                // Not found
            }
        })());
        checks.push((async () => {
            try {
                await execAsync("where winget");
                detected.push("winget");
            }
            catch {
                // Not found
            }
        })());
    }
    // pnpm (cross-platform)
    checks.push((async () => {
        const pnpmPaths = platform === "win32"
            ? [path.join(process.env.LOCALAPPDATA || "", "pnpm")]
            : [path.join(homeDir, ".local", "share", "pnpm")];
        for (const pnpmPath of pnpmPaths) {
            try {
                await fs.access(pnpmPath);
                detected.push("pnpm");
                return;
            }
            catch {
                // Try next path
            }
        }
    })());
    await Promise.all(checks);
    return Array.from(new Set(detected));
}
async function detectWSL() {
    if (process.platform !== "win32") {
        return false;
    }
    try {
        const localAppData = process.env.LOCALAPPDATA || "";
        const packagesDir = path.join(localAppData, "Packages");
        const entries = await fs.readdir(packagesDir);
        return entries.some((entry) => entry.startsWith("CanonicalGroupLimited"));
    }
    catch {
        return false;
    }
}
export async function collectDevEnvironment() {
    const [gitConfig, dotfiles, runtimes, packageManagers, wslDetected] = await Promise.all([
        withTimeout(collectGitConfig(), 2000, null),
        withTimeout(collectDotfiles(), 2000, []),
        withTimeout(collectRuntimes(), 2000, []),
        withTimeout(collectPackageManagers(), 2000, []),
        withTimeout(detectWSL(), 3000, false),
    ]);
    return {
        gitConfig,
        dotfiles,
        runtimes,
        packageManagers,
        wslDetected,
    };
}
export function formatDevEnvironmentForSynthesis(data) {
    const sections = [];
    // Git Identity
    if (data.gitConfig) {
        const lines = ["### Git Identity"];
        const parts = [];
        if (data.gitConfig.name)
            parts.push(`Name: ${data.gitConfig.name}`);
        if (data.gitConfig.email)
            parts.push(`Email: ${data.gitConfig.email}`);
        if (data.gitConfig.defaultBranch)
            parts.push(`Default Branch: ${data.gitConfig.defaultBranch}`);
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
