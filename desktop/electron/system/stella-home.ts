import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { App } from "electron";

export type StellaHome = {
  homePath: string;
  agentsPath: string;
  skillsPath: string;
  statePath: string;
  logsPath: string;
  canvasPath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureDir = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const BUNDLED_SKILLS_DIR = path.resolve(__dirname, "..", "bundled-skills");
const BUNDLED_AGENTS_DIR = path.resolve(__dirname, "..", "bundled-agents");

/**
 * Copy bundled directories into a target path if they don't already exist.
 * Only creates new subdirectories — never overwrites user modifications.
 * Used for both bundled skills and bundled agents.
 */
const seedBundledDir = async (sourceRoot: string, targetRoot: string) => {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  } catch {
    return; // No bundled directory (e.g. in tests)
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const targetDir = path.join(targetRoot, entry.name);
    try {
      await fs.access(targetDir);
      continue; // Already exists — don't overwrite
    } catch {
      // Doesn't exist yet — seed it
    }

    const sourceDir = path.join(sourceRoot, entry.name);
    await ensureDir(targetDir);

    const files = await fs.readdir(sourceDir);
    for (const file of files) {
      await fs.copyFile(
        path.join(sourceDir, file),
        path.join(targetDir, file),
      );
    }
  }
};

const seedBundledSkills = (skillsPath: string) =>
  seedBundledDir(BUNDLED_SKILLS_DIR, skillsPath);

export const resolveStellaHome = async (app: App): Promise<StellaHome> => {
  const homePath = path.join(app.getPath("home"), ".stella");

  const agentsPath = path.join(homePath, "agents");
  const skillsPath = path.join(homePath, "skills");
  const statePath = path.join(homePath, "state");
  const logsPath = path.join(homePath, "logs");
  const canvasPath = path.join(homePath, "canvas");

  await ensureDir(homePath);
  await ensureDir(agentsPath);
  await ensureDir(skillsPath);
  await ensureDir(statePath);
  await ensureDir(logsPath);
  await ensureDir(canvasPath);

  await seedBundledSkills(skillsPath);
  await seedBundledDir(BUNDLED_AGENTS_DIR, agentsPath);

  return {
    homePath,
    agentsPath,
    skillsPath,
    statePath,
    logsPath,
    canvasPath,
  };
};
