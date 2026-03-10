import path from "path";
import { fileURLToPath } from "url";
import type { App } from "electron";
import { ensurePrivateDir } from "./private-fs.js";

export type StellaHome = {
  homePath: string;
  agentsPath: string;
  coreSkillsPath: string;
  skillsPath: string;
  statePath: string;
  logsPath: string;
  canvasPath: string;
  workspacePath: string;
  workspacePanelsPath: string;
  workspaceAppsPath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureDir = async (dirPath: string) => {
  await ensurePrivateDir(dirPath);
};

export const resolveStellaHome = async (_app: App): Promise<StellaHome> => {
  const homePath = path.resolve(__dirname, "..", "..", "..", ".stella");
  const workspacePath = path.resolve(__dirname, "..", "..", "..", "workspace");

  const agentsPath = path.join(homePath, "agents");
  const coreSkillsPath = path.join(homePath, "core-skills");
  const skillsPath = path.join(homePath, "skills");
  const statePath = path.join(homePath, "state");
  const logsPath = path.join(homePath, "logs");
  const canvasPath = path.join(homePath, "canvas");
  const workspacePanelsPath = path.join(workspacePath, "panels");
  const workspaceAppsPath = path.join(workspacePath, "apps");

  await ensureDir(homePath);
  await ensureDir(agentsPath);
  await ensureDir(coreSkillsPath);
  await ensureDir(skillsPath);
  await ensureDir(statePath);
  await ensureDir(logsPath);
  await ensureDir(canvasPath);
  await ensureDir(workspacePath);
  await ensureDir(workspacePanelsPath);
  await ensureDir(workspaceAppsPath);

  return {
    homePath,
    agentsPath,
    coreSkillsPath,
    skillsPath,
    statePath,
    logsPath,
    canvasPath,
    workspacePath,
    workspacePanelsPath,
    workspaceAppsPath,
  };
};
