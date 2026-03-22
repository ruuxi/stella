import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import type { StellaHostRunner } from "../stella-host-runner.js";
import { waitForConnectedRunner } from "./runtime-availability.js";

type ProjectHandlersOptions = {
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const waitForRunner = async (
  options: ProjectHandlersOptions,
  timeoutMs = 10_000,
) =>
  await waitForConnectedRunner(options.getStellaHostRunner, {
    timeoutMs,
    unavailableMessage: "Runtime not available.",
    onRunnerChanged: options.onStellaHostRunnerChanged,
  });

export const registerProjectHandlers = (options: ProjectHandlersOptions) => {
  ipcMain.handle("projects:list", async (event) => {
    if (!options.assertPrivilegedSender(event, "projects:list")) {
      throw new Error("Blocked untrusted request.");
    }
    return await (await waitForRunner(options)).listProjects();
  });

  ipcMain.handle("projects:pickDirectory", async (event) => {
    if (!options.assertPrivilegedSender(event, "projects:pickDirectory")) {
      throw new Error("Blocked untrusted request.");
    }

    const runner = await waitForRunner(options);
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      properties: ["openDirectory"],
      title: "Choose a local project",
      buttonLabel: "Use Project",
    };
    const selection = browserWindow
      ? await dialog.showOpenDialog(browserWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (selection.canceled || selection.filePaths.length === 0) {
      return {
        canceled: true,
        projects: await runner.listProjects(),
      };
    }

    const result = await runner.registerProjectDirectory(selection.filePaths[0]);
    return {
      canceled: false,
      ...result,
    };
  });

  ipcMain.handle("projects:start", async (event, payload: { projectId?: string }) => {
    if (!options.assertPrivilegedSender(event, "projects:start")) {
      throw new Error("Blocked untrusted request.");
    }
    const projectId =
      typeof payload?.projectId === "string" ? payload.projectId.trim() : "";
    if (!projectId) {
      throw new Error("Project ID is required.");
    }
    return await (await waitForRunner(options)).startProject(projectId);
  });

  ipcMain.handle("projects:stop", async (event, payload: { projectId?: string }) => {
    if (!options.assertPrivilegedSender(event, "projects:stop")) {
      throw new Error("Blocked untrusted request.");
    }
    const projectId =
      typeof payload?.projectId === "string" ? payload.projectId.trim() : "";
    if (!projectId) {
      throw new Error("Project ID is required.");
    }
    return await (await waitForRunner(options)).stopProject(projectId);
  });
};
