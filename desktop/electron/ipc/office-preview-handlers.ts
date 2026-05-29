import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { arch, platform } from "node:os";
import { spawn } from "node:child_process";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  IPC_OFFICE_PREVIEW_LIST,
  IPC_OFFICE_PREVIEW_START,
} from "../../src/shared/contracts/ipc-channels.js";
import type {
  OfficePreviewFormat,
  OfficePreviewRef,
  OfficePreviewSnapshot,
} from "../../../runtime/contracts/office-preview.js";
import { listOfficePreviewSnapshots } from "../bootstrap/office-preview-bridge.js";
import type { LocalChatHistoryService } from "../services/local-chat-history-service.js";
import {
  isDisplayReadPathInLocalChatFiles,
  isMobileBridgeSender,
} from "./display-handlers.js";
import type { LocalChatEventRecord } from "../../../runtime/kernel/storage/shared.js";

type OfficePreviewHandlersOptions = {
  getStellaRoot: () => string | null;
  getStellaHome: () => string | null;
  localChatHistoryService?: LocalChatHistoryService;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

type MobileOfficePreviewPolicy = {
  fileEvents: readonly LocalChatEventRecord[];
  artifactPaths: ReadonlySet<string>;
};

const PREVIEW_ROOT_DIRNAME = "office-previews";
const SESSION_MANIFEST_NAME = "session.json";
const SESSION_HTML_NAME = "preview.html";

const formatForPath = (filePath: string): OfficePreviewFormat => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".docx") return "docx";
  if (extension === ".xlsx" || extension === ".xlsm") return "xlsx";
  if (extension === ".pptx") return "pptx";
  return null;
};

const getOfficeBinaryName = () => {
  const os = platform();
  const cpu = arch();
  const osKey =
    os === "darwin"
      ? "darwin"
      : os === "linux"
        ? "linux"
        : os === "win32"
          ? "win32"
          : null;
  const archKey = cpu === "x64" ? "x64" : cpu === "arm64" ? "arm64" : null;
  if (!osKey || !archKey) {
    throw new Error(`Unsupported platform for Office preview: ${os}-${cpu}`);
  }
  return `stella-office-${osKey}-${archKey}${os === "win32" ? ".exe" : ""}`;
};

const writeManifest = async (
  sessionDir: string,
  ref: OfficePreviewRef,
  format: OfficePreviewFormat,
  status: "starting" | "ready" | "error",
  startedAt: number,
  error?: string,
) => {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, SESSION_MANIFEST_NAME),
    `${JSON.stringify(
      {
        sessionId: ref.sessionId,
        title: ref.title,
        sourcePath: ref.sourcePath,
        format,
        startedAt,
        updatedAt: Date.now(),
        status,
        ...(error ? { error } : {}),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
};

const renderOfficeHtml = async (
  binaryPath: string,
  sourcePath: string,
): Promise<string> => {
  const result = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(binaryPath, ["view", sourcePath, "html"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });

  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout).trim() || "Office preview failed.",
    );
  }
  return result.stdout;
};

export const filterOfficePreviewSnapshotsForMobile = (
  snapshots: readonly OfficePreviewSnapshot[],
  policy: MobileOfficePreviewPolicy,
): OfficePreviewSnapshot[] =>
  snapshots.filter((snapshot) =>
    isMobileOfficePreviewPathAllowed(policy, snapshot.sourcePath),
  );

const officePreviewArtifactPath = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (
    record.kind === "office" &&
    record.previewRef &&
    typeof record.previewRef === "object" &&
    typeof (record.previewRef as { sourcePath?: unknown }).sourcePath ===
      "string"
  ) {
    return (record.previewRef as { sourcePath: string }).sourcePath;
  }
  if (
    record.kind === "file-artifact" &&
    typeof record.filePath === "string" &&
    (record.artifactKind === "office-document" ||
      record.artifactKind === "office-spreadsheet" ||
      record.artifactKind === "office-slides")
  ) {
    return record.filePath;
  }
  return null;
};

const collectOfficePreviewArtifactPaths = (
  messages: ReturnType<LocalChatHistoryService["listSyncMessages"]>,
): ReadonlySet<string> => {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) {
      const sourcePath = officePreviewArtifactPath(artifact);
      if (sourcePath) paths.add(path.resolve(sourcePath));
    }
  }
  return paths;
};

const isMobileOfficePreviewPathAllowed = (
  policy: MobileOfficePreviewPolicy,
  sourcePath: string,
): boolean =>
  isDisplayReadPathInLocalChatFiles(policy.fileEvents, sourcePath) ||
  policy.artifactPaths.has(path.resolve(sourcePath));

export const registerOfficePreviewHandlers = (
  options: OfficePreviewHandlersOptions,
) => {
  const requireMobileConversationFileEvents = (
    event: IpcMainEvent | IpcMainInvokeEvent,
    payload: { conversationId?: unknown } | undefined,
    channel: string,
  ): MobileOfficePreviewPolicy | null => {
    if (!isMobileBridgeSender(event)) return null;
    const conversationId =
      typeof payload?.conversationId === "string"
        ? payload.conversationId.trim()
        : "";
    if (!conversationId) {
      throw new Error(`${channel} from mobile requires a conversationId.`);
    }
    if (!options.localChatHistoryService) {
      throw new Error("Local chat file history is unavailable.");
    }
    const fileEvents = options.localChatHistoryService.listFiles({
      conversationId,
      limit: 500,
    }).files;
    const artifactPaths = collectOfficePreviewArtifactPaths(
      options.localChatHistoryService.listSyncMessages({
        conversationId,
        maxMessages: 500,
      }),
    );
    return { fileEvents, artifactPaths };
  };

  ipcMain.handle(
    IPC_OFFICE_PREVIEW_LIST,
    async (event, payload?: { conversationId?: unknown }) => {
      if (!options.assertPrivilegedSender(event, IPC_OFFICE_PREVIEW_LIST)) {
        throw new Error("Blocked untrusted office preview request.");
      }

      const stellaHome = options.getStellaHome();
      if (!stellaHome?.trim()) {
        return [];
      }

      const mobilePolicy = requireMobileConversationFileEvents(
        event,
        payload,
        IPC_OFFICE_PREVIEW_LIST,
      );
      const snapshots = await listOfficePreviewSnapshots(stellaHome);
      return mobilePolicy
        ? filterOfficePreviewSnapshotsForMobile(snapshots, mobilePolicy)
        : snapshots;
    },
  );

  ipcMain.handle(
    IPC_OFFICE_PREVIEW_START,
    async (
      event,
      payload?: { filePath?: unknown; conversationId?: unknown },
    ): Promise<OfficePreviewRef> => {
      if (!options.assertPrivilegedSender(event, IPC_OFFICE_PREVIEW_START)) {
        throw new Error("Blocked untrusted office preview request.");
      }

      const stellaRoot = options.getStellaRoot();
      const stellaHome = options.getStellaHome();
      if (!stellaRoot?.trim() || !stellaHome?.trim()) {
        throw new Error("Office preview requires an initialized Stella root.");
      }
      const requestedPath =
        typeof payload?.filePath === "string" ? payload.filePath.trim() : "";
      if (!requestedPath) {
        throw new Error("officePreview:start requires a filePath.");
      }

      const sourcePath = path.resolve(requestedPath);
      const mobilePolicy = requireMobileConversationFileEvents(
        event,
        payload,
        IPC_OFFICE_PREVIEW_START,
      );
      if (
        mobilePolicy &&
        !isMobileOfficePreviewPathAllowed(mobilePolicy, sourcePath)
      ) {
        throw new Error(
          "officePreview:start from mobile is limited to recent files Stella displayed for the active conversation.",
        );
      }

      const stats = await fs.stat(sourcePath);
      if (!stats.isFile()) {
        throw new Error(`Office preview target is not a file: ${sourcePath}`);
      }

      const format = formatForPath(sourcePath);
      if (!format) {
        throw new Error(
          "Office preview supports .docx, .xlsx, .xlsm, and .pptx files.",
        );
      }

      const sessionId = randomUUID();
      const title = path.basename(sourcePath);
      const ref: OfficePreviewRef = { sessionId, title, sourcePath };
      const sessionDir = path.join(stellaHome, PREVIEW_ROOT_DIRNAME, sessionId);
      const startedAt = Date.now();
      await writeManifest(sessionDir, ref, format, "starting", startedAt);

      const binaryPath = path.join(
        stellaRoot,
        "desktop",
        "stella-office",
        "bin",
        getOfficeBinaryName(),
      );
      void (async () => {
        try {
          const html = await renderOfficeHtml(binaryPath, sourcePath);
          await fs.writeFile(
            path.join(sessionDir, SESSION_HTML_NAME),
            html,
            "utf-8",
          );
          await writeManifest(sessionDir, ref, format, "ready", startedAt);
        } catch (caught) {
          await writeManifest(
            sessionDir,
            ref,
            format,
            "error",
            startedAt,
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      })();

      return ref;
    },
  );
};
