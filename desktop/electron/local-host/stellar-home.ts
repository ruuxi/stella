import { promises as fs } from "fs";
import path from "path";
import type { App } from "electron";

export type StellarHome = {
  homePath: string;
  agentsPath: string;
  skillsPath: string;
  pluginsPath: string;
  statePath: string;
  logsPath: string;
  migrationMarkerPath: string;
};

const MIGRATION_MARKER = "migration.v1.json";

const ensureDir = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const copyIfMissing = async (fromPath: string, toPath: string) => {
  try {
    await fs.access(toPath);
    return false;
  } catch {
    // Destination missing; continue.
  }

  try {
    const stat = await fs.stat(fromPath);
    if (!stat.isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  await ensureDir(path.dirname(toPath));
  await fs.copyFile(fromPath, toPath);
  return true;
};

const migrateDirectoryFiles = async (fromDir: string, toDir: string) => {
  let migratedCount = 0;
  let entries: Array<{ name: string; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(fromDir, { withFileTypes: true });
  } catch {
    return migratedCount;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fromPath = path.join(fromDir, entry.name);
    const toPath = path.join(toDir, entry.name);
    const migrated = await copyIfMissing(fromPath, toPath);
    if (migrated) migratedCount += 1;
  }

  return migratedCount;
};


const migrateFromUserData = async (userDataPath: string, stellarHomePath: string) => {
  const markerPath = path.join(stellarHomePath, MIGRATION_MARKER);
  try {
    await fs.access(markerPath);
    return;
  } catch {
    // No marker; proceed with one-time migration.
  }

  const statePath = path.join(stellarHomePath, "state");
  const todosPath = path.join(statePath, "todos");
  const testsPath = path.join(statePath, "tests");

  await ensureDir(statePath);
  await ensureDir(todosPath);
  await ensureDir(testsPath);

  const migrated: Record<string, number | boolean> = {
    device: false,
    todos: 0,
    tests: 0,
  };

  const deviceMigrated = await copyIfMissing(
    path.join(userDataPath, "device.json"),
    path.join(statePath, "device.json"),
  );
  migrated.device = deviceMigrated;

  migrated.todos = await migrateDirectoryFiles(path.join(userDataPath, "todos"), todosPath);
  migrated.tests = await migrateDirectoryFiles(path.join(userDataPath, "tests"), testsPath);

  await fs.writeFile(
    markerPath,
    JSON.stringify(
      {
        migratedAt: Date.now(),
        fromUserDataPath: userDataPath,
        migrated,
      },
      null,
      2,
    ),
    "utf-8",
  );
};

export const resolveStellarHome = async (
  app: App,
  userDataPath: string,
): Promise<StellarHome> => {
  const homePath = path.join(app.getPath("home"), ".stellar");

  const agentsPath = path.join(homePath, "agents");
  const skillsPath = path.join(homePath, "skills");
  const pluginsPath = path.join(homePath, "plugins");
  const statePath = path.join(homePath, "state");
  const logsPath = path.join(homePath, "logs");
  const migrationMarkerPath = path.join(homePath, MIGRATION_MARKER);

  await ensureDir(homePath);
  await ensureDir(agentsPath);
  await ensureDir(skillsPath);
  await ensureDir(pluginsPath);
  await ensureDir(statePath);
  await ensureDir(logsPath);

  // One-time best-effort migration from Electron userData.
  await migrateFromUserData(userDataPath, homePath);

  return {
    homePath,
    agentsPath,
    skillsPath,
    pluginsPath,
    statePath,
    logsPath,
    migrationMarkerPath,
  };
};
