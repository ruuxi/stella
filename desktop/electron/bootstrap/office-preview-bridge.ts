import fs from "node:fs/promises";
import path from "node:path";
import type {
  OfficePreviewFormat,
  OfficePreviewSnapshot,
  OfficePreviewStatus,
} from "../../src/shared/contracts/office-preview.js";
import { IPC_OFFICE_PREVIEW_UPDATE } from "../../src/shared/contracts/ipc-channels.js";
import { broadcastToWindows, type BootstrapContext } from "./context.js";

type OfficePreviewManifest = {
  sessionId?: unknown;
  title?: unknown;
  sourcePath?: unknown;
  format?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  status?: unknown;
  error?: unknown;
};

const PREVIEW_ROOT_DIRNAME = "office-previews";
const SESSION_MANIFEST_NAME = "session.json";
const SESSION_HTML_NAME = "preview.html";
const POLL_INTERVAL_MS = 1_000;

const isPreviewStatus = (value: unknown): value is OfficePreviewStatus =>
  value === "starting" ||
  value === "ready" ||
  value === "error" ||
  value === "stopped";

const isPreviewFormat = (value: unknown): value is OfficePreviewFormat =>
  value === "docx" || value === "xlsx" || value === "pptx" || value === null;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const resolvePreviewRoot = (stellaRoot: string) =>
  path.join(stellaRoot, "state", PREVIEW_ROOT_DIRNAME);

const readSnapshotFromSessionDir = async (
  sessionDir: string,
): Promise<OfficePreviewSnapshot | null> => {
  try {
    const manifestPath = path.join(sessionDir, SESSION_MANIFEST_NAME);
    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw) as OfficePreviewManifest;
    const sessionId = asString(manifest.sessionId);
    const title = asString(manifest.title);
    const sourcePath = asString(manifest.sourcePath);

    if (!sessionId || !title || !sourcePath) {
      return null;
    }

    let html = "";
    try {
      html = await fs.readFile(path.join(sessionDir, SESSION_HTML_NAME), "utf-8");
    } catch {
      html = "";
    }

    return {
      sessionId,
      title,
      sourcePath,
      format: isPreviewFormat(manifest.format) ? manifest.format : null,
      startedAt: asNumber(manifest.startedAt, Date.now()),
      updatedAt: asNumber(manifest.updatedAt, Date.now()),
      status: isPreviewStatus(manifest.status) ? manifest.status : "starting",
      html,
      ...(typeof manifest.error === "string" && manifest.error.trim()
        ? { error: manifest.error }
        : {}),
    };
  } catch {
    return null;
  }
};

export const listOfficePreviewSnapshots = async (
  stellaRoot: string,
): Promise<OfficePreviewSnapshot[]> => {
  const previewRoot = resolvePreviewRoot(stellaRoot);
  await fs.mkdir(previewRoot, { recursive: true });

  const entries = await fs.readdir(previewRoot, { withFileTypes: true });
  const snapshots = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readSnapshotFromSessionDir(path.join(previewRoot, entry.name))),
  );

  return snapshots
    .filter((snapshot): snapshot is OfficePreviewSnapshot => snapshot !== null)
    .sort((left, right) => left.updatedAt - right.updatedAt);
};

export const startOfficePreviewBridge = (context: BootstrapContext): (() => void) => {
  const stellaRoot = context.state.stellaRoot;
  if (!stellaRoot) {
    return () => {};
  }

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const lastDeliveredAt = new Map<string, number>();

  const scan = async () => {
    try {
      const snapshots = await listOfficePreviewSnapshots(stellaRoot);
      if (stopped) {
        return;
      }

      for (const snapshot of snapshots) {
        const previousUpdatedAt = lastDeliveredAt.get(snapshot.sessionId) ?? -1;
        if (previousUpdatedAt >= snapshot.updatedAt) {
          continue;
        }
        lastDeliveredAt.set(snapshot.sessionId, snapshot.updatedAt);
        broadcastToWindows(context, IPC_OFFICE_PREVIEW_UPDATE, snapshot);
      }
    } catch (error) {
      console.debug(
        "[office-preview] Failed to scan preview sessions:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  void scan();
  timer = setInterval(() => {
    void scan();
  }, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
};
