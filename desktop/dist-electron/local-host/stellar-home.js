import { promises as fs } from "fs";
import path from "path";
const ensureDir = async (dirPath) => {
    await fs.mkdir(dirPath, { recursive: true });
};
export const resolveStellarHome = async (app) => {
    const homePath = path.join(app.getPath("home"), ".stellar");
    const agentsPath = path.join(homePath, "agents");
    const skillsPath = path.join(homePath, "skills");
    const pluginsPath = path.join(homePath, "plugins");
    const statePath = path.join(homePath, "state");
    const logsPath = path.join(homePath, "logs");
    await ensureDir(homePath);
    await ensureDir(agentsPath);
    await ensureDir(skillsPath);
    await ensureDir(pluginsPath);
    await ensureDir(statePath);
    await ensureDir(logsPath);
    return {
        homePath,
        agentsPath,
        skillsPath,
        pluginsPath,
        statePath,
        logsPath,
    };
};
