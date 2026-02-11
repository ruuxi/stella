import { promises as fs } from "fs";
import path from "path";
const ensureDir = async (dirPath) => {
    await fs.mkdir(dirPath, { recursive: true });
};
export const resolveStellaHome = async (app) => {
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
    return {
        homePath,
        agentsPath,
        skillsPath,
        statePath,
        logsPath,
        canvasPath,
    };
};
