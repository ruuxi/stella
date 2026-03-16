import path from "path";
import { promises as fs } from "fs";
import { ConvexClient } from "convex/browser";
import { api } from "../../src/convex/api.js";
import type { ChatStore } from "../storage/chat-store.js";
import { SocialSessionStore, type SocialSessionRole, type SocialSessionSyncRecord } from "../storage/social-session-store.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import {
  applySessionFileOp,
  ensurePathWithinRoot,
  inferFileContentType,
  normalizeSessionRelativePath,
  resolveSessionLocalFolder,
  scanSessionWorkspace,
} from "./social-session-fs.js";
import type { SocialSessionServiceSnapshot, SocialSessionRuntimeRecord } from "../../src/shared/contracts/electron-data.js";

type RemoteSessionSummary = {
  room: {
    _id: string;
  };
  session: {
    _id: string;
    hostOwnerId: string;
    hostDeviceId: string;
    workspaceFolderName: string;
    conversationId: string;
    status: "active" | "paused" | "ended";
  };
  membershipRole: "owner" | "member";
  isHost: boolean;
};

type PendingTurnEnvelope = {
  session: {
    _id: string;
    conversationId: string;
  };
  turn: {
    _id: string;
    ordinal: number;
    prompt: string;
    requestId?: string;
    agentType?: string;
  };
};

type FileOpEnvelope = {
  op: {
    ordinal: number;
    type: "upsert" | "delete" | "mkdir";
    relativePath: string;
    actorOwnerId: string;
  };
  downloadUrl?: string;
};

type SessionRuntime = SocialSessionSyncRecord & {
  sessionConversationId: string;
  hostOwnerId: string;
  hostDeviceId: string;
  isActiveHost: boolean;
};

type SocialSessionServiceDeps = {
  getWorkspaceRoot: () => string | null;
  getDeviceId: () => string | null;
  getRunner: () => StellaHostRunner | null;
  getChatStore: () => ChatStore | null;
  getStore: () => SocialSessionStore | null;
};

const TICK_INTERVAL_MS = 2_500;
const MAX_FILE_SYNC_OPS_PER_TICK = 32;

const sanitizeConvexDeploymentUrl = (value: string | null) => {
  const trimmed = value?.trim() || "";
  return trimmed || null;
};

const toSessionRole = (summary: RemoteSessionSummary): SocialSessionRole =>
  summary.isHost ? "host" : "follower";

export class SocialSessionService {
  private convexDeploymentUrl: string | null = null;
  private authToken: string | null = null;
  private client: ConvexClient | null = null;
  private clientUrl: string | null = null;
  private started = false;
  private sessionsUnsubscribe: (() => void) | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private tickRunning = false;
  private activeSessions = new Map<string, SessionRuntime>();
  private processingTurnId: string | null = null;
  private lastError: string | null = null;
  private lastSyncAt: number | null = null;

  constructor(private readonly deps: SocialSessionServiceDeps) {}

  private ensureClient(): ConvexClient | null {
    const deploymentUrl = sanitizeConvexDeploymentUrl(this.convexDeploymentUrl);
    if (!deploymentUrl || !this.authToken?.trim()) {
      this.disposeClient();
      return null;
    }
    if (this.client && this.clientUrl === deploymentUrl) {
      return this.client;
    }
    this.disposeClient();
    const client = new ConvexClient(deploymentUrl, {
      logger: false,
      unsavedChangesWarning: false,
    });
    client.setAuth(async () => this.authToken?.trim() || null);
    this.client = client;
    this.clientUrl = deploymentUrl;
    return client;
  }

  private disposeClient() {
    const client = this.client;
    this.client = null;
    this.clientUrl = null;
    if (client) {
      void client.close().catch(() => undefined);
    }
  }

  private clearTickTimer() {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private scheduleTick() {
    this.clearTickTimer();
    if (!this.started) {
      return;
    }
    this.tickTimer = setTimeout(() => {
      void this.runTick();
    }, TICK_INTERVAL_MS);
  }

  private rebuildSessionSnapshot(): SocialSessionRuntimeRecord[] {
    return [...this.activeSessions.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        role: session.role,
        hostDeviceId: session.hostDeviceId,
        isActiveHost: session.isActiveHost,
        localFolderPath: session.localFolderPath,
        localFolderName: session.localFolderName,
        lastAppliedFileOpOrdinal: session.lastAppliedFileOpOrdinal,
        lastObservedTurnOrdinal: session.lastObservedTurnOrdinal,
      }));
  }

  getSnapshot(): SocialSessionServiceSnapshot {
    const clientReady = Boolean(this.client && this.clientUrl);
    return {
      enabled: this.started,
      status: !this.started
        ? "stopped"
        : clientReady
          ? "running"
          : "connecting",
      deviceId: this.deps.getDeviceId() ?? undefined,
      sessionCount: this.activeSessions.size,
      sessions: this.rebuildSessionSnapshot(),
      lastError: this.lastError ?? undefined,
      lastSyncAt: this.lastSyncAt ?? undefined,
      processingTurnId: this.processingTurnId ?? undefined,
    };
  }

  setConvexUrl(value: string | null) {
    this.convexDeploymentUrl = sanitizeConvexDeploymentUrl(value);
    this.refreshSessionSubscription();
  }

  setAuthToken(value: string | null) {
    this.authToken = value?.trim() || null;
    if (this.client) {
      this.client.setAuth(async () => this.authToken?.trim() || null);
    }
    this.refreshSessionSubscription();
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    void fs.mkdir(this.getWorkspaceRoot(), { recursive: true }).catch(() => undefined);
    this.refreshSessionSubscription();
    this.scheduleTick();
  }

  stop() {
    this.started = false;
    this.clearTickTimer();
    this.sessionsUnsubscribe?.();
    this.sessionsUnsubscribe = null;
    this.activeSessions.clear();
    this.processingTurnId = null;
    this.disposeClient();
  }

  private getWorkspaceRoot() {
    const workspaceRoot = this.deps.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Social session workspace root is unavailable.");
    }
    return path.join(workspaceRoot, "social-sessions");
  }

  private refreshSessionSubscription() {
    this.sessionsUnsubscribe?.();
    this.sessionsUnsubscribe = null;
    if (!this.started) {
      return;
    }
    const client = this.ensureClient();
    if (!client) {
      this.activeSessions.clear();
      return;
    }
    this.sessionsUnsubscribe = client.onUpdate(
      (api as any).social.sessions.listSessions,
      {},
      (payload: unknown) => {
        void this.reconcileRemoteSessions(payload as RemoteSessionSummary[]);
      },
      (error) => {
        this.lastError = error.message;
      },
    ).unsubscribe;
  }

  private async reconcileRemoteSessions(summaries: RemoteSessionSummary[]) {
    const deviceId = this.deps.getDeviceId();
    const nextIds = new Set<string>();

    for (const summary of summaries) {
      if (summary.session.status === "ended") {
        continue;
      }
      nextIds.add(summary.session._id);
      const store = this.deps.getStore();
      if (!store) {
        continue;
      }
      const existing = store.getSession(summary.session._id);
      const localFolderPath =
        existing?.localFolderPath
        || resolveSessionLocalFolder(
          this.getWorkspaceRoot(),
          summary.session._id,
          summary.session.workspaceFolderName,
        );
      await fs.mkdir(localFolderPath, { recursive: true });
      const role = toSessionRole(summary);
      const record = store.upsertSession({
        sessionId: summary.session._id,
        localFolderPath,
        localFolderName: summary.session.workspaceFolderName,
        role,
        lastAppliedFileOpOrdinal: existing?.lastAppliedFileOpOrdinal ?? 0,
        lastObservedTurnOrdinal: existing?.lastObservedTurnOrdinal ?? 0,
      });
      this.activeSessions.set(summary.session._id, {
        ...record,
        sessionConversationId: summary.session.conversationId,
        hostOwnerId: summary.session.hostOwnerId,
        hostDeviceId: summary.session.hostDeviceId,
        isActiveHost: role === "host" && Boolean(deviceId) && summary.session.hostDeviceId === deviceId,
      });
    }

    for (const sessionId of [...this.activeSessions.keys()]) {
      if (!nextIds.has(sessionId)) {
        this.activeSessions.delete(sessionId);
      }
    }
  }

  private async runTick() {
    if (!this.started || this.tickRunning) {
      return;
    }
    this.tickRunning = true;
    try {
    const client = this.ensureClient();
      if (!client) {
        return;
      }
      await this.processPendingHostTurns(client);
      for (const session of this.activeSessions.values()) {
        await this.applyRemoteFileOps(client, session);
        if (session.isActiveHost) {
          await this.syncHostWorkspace(client, session);
        }
      }
      this.lastSyncAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message;
    } finally {
      this.tickRunning = false;
      this.scheduleTick();
    }
  }

  private async processPendingHostTurns(client: ConvexClient) {
    const deviceId = this.deps.getDeviceId();
    const runner = this.deps.getRunner();
    const chatStore = this.deps.getChatStore();
    if (!deviceId || !runner || this.processingTurnId) {
      return;
    }
    if (runner.getActiveOrchestratorRun()) {
      return;
    }

    const pendingTurns = await (client as any).query(
      (api as any).social.sessions.listPendingTurnsForHostDevice,
      { deviceId },
    ) as PendingTurnEnvelope[];
    const nextTurn = pendingTurns[0];
    if (!nextTurn) {
      return;
    }

    this.processingTurnId = nextTurn.turn._id;
    try {
      const claimResult = await (client as any).mutation(
        (api as any).social.sessions.claimTurn,
        {
          sessionId: nextTurn.session._id,
          turnId: nextTurn.turn._id,
          deviceId,
        },
      ) as { claimed: boolean };
      if (!claimResult.claimed) {
        return;
      }

      const store = this.deps.getStore();
      if (!store) {
        return;
      }
      if (chatStore) {
        chatStore.appendEvent({
          conversationId: nextTurn.session.conversationId,
          eventId: `stella-turn-user:${nextTurn.turn._id}`,
          type: "user_message",
          requestId: nextTurn.turn.requestId ?? nextTurn.turn._id,
          payload: { text: nextTurn.turn.prompt },
          timestamp: Date.now(),
          deviceId,
        });
      }

      const result = await runner.runAutomationTurn({
        conversationId: nextTurn.session.conversationId,
        userPrompt: nextTurn.turn.prompt,
        agentType: nextTurn.turn.agentType,
      });

      if (result.status === "busy") {
        await (client as any).mutation((api as any).social.sessions.releaseTurn, {
          sessionId: nextTurn.session._id,
          turnId: nextTurn.turn._id,
          deviceId,
        });
        return;
      }

      if (result.status === "error") {
        await (client as any).mutation((api as any).social.sessions.failTurn, {
          sessionId: nextTurn.session._id,
          turnId: nextTurn.turn._id,
          deviceId,
          error: result.error,
        });
        return;
      }

      if (chatStore) {
        chatStore.appendEvent({
          conversationId: nextTurn.session.conversationId,
          eventId: `stella-turn-assistant:${nextTurn.turn._id}`,
          type: "assistant_message",
          requestId: nextTurn.turn.requestId ?? nextTurn.turn._id,
          payload: { text: result.finalText },
          timestamp: Date.now(),
        });
      }

      await (client as any).mutation((api as any).social.sessions.completeTurn, {
        sessionId: nextTurn.session._id,
        turnId: nextTurn.turn._id,
        deviceId,
        resultText: result.finalText,
      });
      store.patchSession(nextTurn.session._id, {
        lastObservedTurnOrdinal: nextTurn.turn.ordinal,
      });
      const session = this.activeSessions.get(nextTurn.session._id);
      if (session) {
        session.lastObservedTurnOrdinal = nextTurn.turn.ordinal;
      }
    } finally {
      this.processingTurnId = null;
    }
  }

  private async applyRemoteFileOps(client: ConvexClient, session: SessionRuntime) {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }
    const ops = await (client as any).query(
      (api as any).social.sessions.listFileOps,
      {
        sessionId: session.sessionId,
        afterOrdinal: session.lastAppliedFileOpOrdinal,
        limit: MAX_FILE_SYNC_OPS_PER_TICK,
      },
    ) as FileOpEnvelope[];
    if (ops.length === 0) {
      return;
    }

    for (const entry of ops) {
      const { op } = entry;
      if (!(session.isActiveHost && op.actorOwnerId === session.hostOwnerId)) {
        if (op.type === "upsert") {
          if (!entry.downloadUrl) {
            throw new Error(`Missing download URL for file op ${session.sessionId}:${op.ordinal}`);
          }
          const response = await fetch(entry.downloadUrl);
          if (!response.ok) {
            throw new Error(`Failed to download session file: ${response.status}`);
          }
          const buffer = new Uint8Array(await response.arrayBuffer());
          await applySessionFileOp({
            rootPath: session.localFolderPath,
            type: "upsert",
            relativePath: op.relativePath,
            bytes: buffer,
          });
          const absolutePath = ensurePathWithinRoot(session.localFolderPath, op.relativePath);
          const stat = await fs.stat(absolutePath);
          store.upsertFile({
            sessionId: session.sessionId,
            relativePath: normalizeSessionRelativePath(op.relativePath),
            contentHash: "",
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } else {
          await applySessionFileOp({
            rootPath: session.localFolderPath,
            type: op.type,
            relativePath: op.relativePath,
          });
          if (op.type === "delete") {
            store.removeFile(session.sessionId, normalizeSessionRelativePath(op.relativePath));
          }
        }
      }
      session.lastAppliedFileOpOrdinal = op.ordinal;
      store.patchSession(session.sessionId, {
        lastAppliedFileOpOrdinal: op.ordinal,
      });
    }

    await (client as any).mutation((api as any).social.sessions.acknowledgeFileOps, {
      sessionId: session.sessionId,
      lastAppliedOrdinal: session.lastAppliedFileOpOrdinal,
    });
  }

  private async syncHostWorkspace(client: ConvexClient, session: SessionRuntime) {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }
    const currentFiles = await scanSessionWorkspace(session.localFolderPath);
    const previousFiles = new Map(
      store.listFiles(session.sessionId).map((record) => [record.relativePath, record]),
    );

    for (const file of currentFiles) {
      const previous = previousFiles.get(file.relativePath);
      if (
        previous
        && previous.contentHash === file.contentHash
        && previous.sizeBytes === file.sizeBytes
      ) {
        previousFiles.delete(file.relativePath);
        continue;
      }

      const base64Content = (await fs.readFile(file.absolutePath)).toString("base64");
      await (client as any).action((api as any).social.sessions.uploadFile, {
        sessionId: session.sessionId,
        relativePath: file.relativePath,
        contentBase64: base64Content,
        contentHash: file.contentHash,
        contentType: inferFileContentType(file.relativePath),
      });
      store.upsertFile({
        sessionId: session.sessionId,
        relativePath: file.relativePath,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
      });
      previousFiles.delete(file.relativePath);
    }

    for (const [relativePath] of previousFiles) {
      await (client as any).mutation((api as any).social.sessions.deleteFile, {
        sessionId: session.sessionId,
        relativePath,
      });
      store.removeFile(session.sessionId, relativePath);
    }
  }
}
