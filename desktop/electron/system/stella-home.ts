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
  workspacePath: string;
  workspacePanelsPath: string;
  workspaceAppsPath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureDir = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const resolveStellaHome = async (_app: App): Promise<StellaHome> => {
  const homePath = path.resolve(__dirname, "..", "..", "..", ".stella");

  const agentsPath = path.join(homePath, "agents");
  const skillsPath = path.join(homePath, "skills");
  const statePath = path.join(homePath, "state");
  const logsPath = path.join(homePath, "logs");
  const canvasPath = path.join(homePath, "canvas");
  const workspacePath = path.join(homePath, "workspace");
  const workspacePanelsPath = path.join(workspacePath, "panels");
  const workspaceAppsPath = path.join(workspacePath, "apps");

  await ensureDir(homePath);
  await ensureDir(agentsPath);
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
    skillsPath,
    statePath,
    logsPath,
    canvasPath,
    workspacePath,
    workspacePanelsPath,
    workspaceAppsPath,
  };
};
