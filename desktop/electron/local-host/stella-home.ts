import { promises as fs } from "fs";
import path from "path";
import type { App } from "electron";

export type StellaHome = {
  homePath: string;
  agentsPath: string;
  skillsPath: string;
  pluginsPath: string;
  statePath: string;
  logsPath: string;
  canvasPath: string;
};

const ensureDir = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const resolveStellaHome = async (app: App): Promise<StellaHome> => {
  const homePath = path.join(app.getPath("home"), ".stella");

  const agentsPath = path.join(homePath, "agents");
  const skillsPath = path.join(homePath, "skills");
  const pluginsPath = path.join(homePath, "plugins");
  const statePath = path.join(homePath, "state");
  const logsPath = path.join(homePath, "logs");
  const canvasPath = path.join(homePath, "canvas");

  await ensureDir(homePath);
  await ensureDir(agentsPath);
  await ensureDir(skillsPath);
  await ensureDir(pluginsPath);
  await ensureDir(statePath);
  await ensureDir(logsPath);
  await ensureDir(canvasPath);

  return {
    homePath,
    agentsPath,
    skillsPath,
    pluginsPath,
    statePath,
    logsPath,
    canvasPath,
  };
};
