/**
 * IPC handlers for game lifecycle: create, build, deploy, share.
 */

import { ipcMain } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";

type GameHandlerDeps = {
  getStellaHomePath: () => string | null;
  assertPrivilegedSender: (
    event: Electron.IpcMainInvokeEvent,
    channel: string,
  ) => void;
  getConvexClient: () => { action: (ref: unknown, args: unknown) => Promise<unknown> } | null;
  getFrontendRoot: () => string | null;
};

const WORKSPACE_APPS_DIR = "workspace/apps";
const CONTENT_TYPE_MAP: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain",
};

const getContentType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
};

const isTextContentType = (contentType: string): boolean =>
  contentType.startsWith("text/")
  || contentType === "application/javascript"
  || contentType === "application/json"
  || contentType === "image/svg+xml";

const resolveAppsDir = (frontendRoot: string): string =>
  path.join(frontendRoot, WORKSPACE_APPS_DIR);

const resolveGameDir = (frontendRoot: string, gameId: string): string =>
  path.join(resolveAppsDir(frontendRoot), gameId);

/**
 * Recursively collect all files in a directory with their relative paths.
 */
const collectFiles = async (
  dir: string,
  basePath = "",
): Promise<Array<{ relativePath: string; absolutePath: string }>> => {
  const results: Array<{ relativePath: string; absolutePath: string }> = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const nested = await collectFiles(absolutePath, relativePath);
      results.push(...nested);
    } else if (entry.isFile()) {
      results.push({ relativePath, absolutePath });
    }
  }

  return results;
};

/**
 * Run a shell command and return stdout/stderr.
 */
const runCommand = (
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  new Promise((resolve) => {
    const cmd = process.platform === "win32" && command === "npm"
      ? "npm.cmd"
      : command;

    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, BROWSER: "none" },
      stdio: "pipe",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });

export const registerGameHandlers = (deps: GameHandlerDeps) => {
  /**
   * games:create — Create a workspace app from the game template.
   */
  ipcMain.handle("games:create", async (event, payload: {
    gameId: string;
    spacetimedbModule?: string;
  }) => {
    deps.assertPrivilegedSender(event, "games:create");
    const frontendRoot = deps.getFrontendRoot();
    if (!frontendRoot) throw new Error("Frontend root not available");

    const scriptPath = path.join(frontendRoot, "scripts", "create-workspace-app.mjs");
    const args = [
      scriptPath,
      payload.gameId,
      "--template", "game",
    ];
    if (payload.spacetimedbModule) {
      args.push("--spacetimedb-module", payload.spacetimedbModule);
    }

    const result = await runCommand(process.execPath, args, frontendRoot);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create game app: ${result.stderr || result.stdout}`);
    }

    return {
      gameId: payload.gameId,
      path: resolveGameDir(frontendRoot, payload.gameId),
    };
  });

  /**
   * games:build — Run `npm run build` in the game's workspace directory.
   */
  ipcMain.handle("games:build", async (event, payload: { gameId: string }) => {
    deps.assertPrivilegedSender(event, "games:build");
    const frontendRoot = deps.getFrontendRoot();
    if (!frontendRoot) throw new Error("Frontend root not available");

    const gameDir = resolveGameDir(frontendRoot, payload.gameId);
    const stat = await fs.stat(gameDir).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`Game directory not found: ${gameDir}`);
    }

    // Install dependencies
    const installResult = await runCommand("npm", ["install"], gameDir);
    if (installResult.exitCode !== 0) {
      throw new Error(`npm install failed: ${installResult.stderr}`);
    }

    // Build
    const buildResult = await runCommand("npm", ["run", "build"], gameDir);
    if (buildResult.exitCode !== 0) {
      throw new Error(`Build failed: ${buildResult.stderr}`);
    }

    const distDir = path.join(gameDir, "dist");
    const distStat = await fs.stat(distDir).catch(() => null);
    if (!distStat?.isDirectory()) {
      throw new Error("Build produced no dist/ directory");
    }

    return { gameId: payload.gameId, distPath: distDir };
  });

  /**
   * games:deploy — Read built files from dist/ and upload to Convex.
   */
  ipcMain.handle("games:deploy", async (event, payload: { gameId: string }) => {
    deps.assertPrivilegedSender(event, "games:deploy");
    const frontendRoot = deps.getFrontendRoot();
    if (!frontendRoot) throw new Error("Frontend root not available");

    const convex = deps.getConvexClient();
    if (!convex) throw new Error("Not connected to Convex");

    const distDir = path.join(resolveGameDir(frontendRoot, payload.gameId), "dist");
    const files = await collectFiles(distDir);

    if (files.length === 0) {
      throw new Error("No files found in dist/. Run games:build first.");
    }

    // Read all files and prepare for upload
    const filePayloads = await Promise.all(
      files.map(async (file) => {
        const contentType = getContentType(file.absolutePath);
        const fileBuffer = await fs.readFile(file.absolutePath);
        const encoding = isTextContentType(contentType) ? "utf8" : "base64";
        return {
          path: file.relativePath,
          content: encoding === "utf8"
            ? fileBuffer.toString("utf-8")
            : fileBuffer.toString("base64"),
          contentType,
          encoding,
        };
      }),
    );

    // Call Convex action to deploy
    const result = await convex.action(
      // Reference will be resolved by Convex client at runtime
      "data/games:deployGameBuild" as unknown,
      {
        gameId: payload.gameId,
        files: filePayloads,
      },
    ) as { gameId: string; deploymentPath: string; assetCount: number };

    return result;
  });

  /**
   * games:getJoinInfo — Return the join code and shareable URL for a game.
   */
  ipcMain.handle("games:getJoinInfo", async (event, payload: { gameId: string }) => {
    deps.assertPrivilegedSender(event, "games:getJoinInfo");
    const convex = deps.getConvexClient();
    if (!convex) throw new Error("Not connected to Convex");

    const game = await convex.action(
      "data/games:getGame" as unknown,
      { gameId: payload.gameId },
    ) as {
      gameId: string;
      joinCode: string;
      deploymentPath?: string;
      displayName: string;
    } | null;

    if (!game) throw new Error("Game not found");

    return {
      gameId: game.gameId,
      joinCode: game.joinCode,
      displayName: game.displayName,
      deploymentPath: game.deploymentPath,
    };
  });

  /**
   * games:list — List the user's games.
   */
  ipcMain.handle("games:list", async (event) => {
    deps.assertPrivilegedSender(event, "games:list");
    const convex = deps.getConvexClient();
    if (!convex) return [];

    return await convex.action(
      "data/games:listGames" as unknown,
      {},
    );
  });

  /**
   * games:archive — Archive a game.
   */
  ipcMain.handle("games:archive", async (event, payload: { gameId: string }) => {
    deps.assertPrivilegedSender(event, "games:archive");
    const convex = deps.getConvexClient();
    if (!convex) throw new Error("Not connected to Convex");

    return await convex.action(
      "data/games:archiveGame" as unknown,
      { gameId: payload.gameId },
    );
  });
};
