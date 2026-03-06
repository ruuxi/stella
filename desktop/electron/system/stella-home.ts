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

/**
 * Copy bundled skills into ~/.stella/skills/ if they don't already exist.
 * Only creates new skill directories — never overwrites user modifications.
 */
const seedBundledSkills = async (skillsPath: string) => {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(BUNDLED_SKILLS_DIR, { withFileTypes: true });
  } catch {
    return; // No bundled skills directory (e.g. in tests)
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const targetDir = path.join(skillsPath, entry.name);
    try {
      await fs.access(targetDir);
      continue; // Already exists — don't overwrite
    } catch {
      // Doesn't exist yet — seed it
    }

    const sourceDir = path.join(BUNDLED_SKILLS_DIR, entry.name);
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

  return {
    homePath,
    agentsPath,
    skillsPath,
    statePath,
    logsPath,
    canvasPath,
  };
};
