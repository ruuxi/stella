import {
  app,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  getSyncMode,
  loadLocalPreferences,
  saveLocalPreferences,
} from "../../../runtime/kernel/preferences/local-preferences.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { AuthService } from "../services/auth-service.js";
import type { BackupService } from "../services/backup-service.js";
import type { ExternalLinkService } from "../services/external-link-service.js";
import {
  deleteLocalLlmCredential,
  listLocalLlmCredentials,
  saveLocalLlmCredential,
} from "../../../runtime/kernel/storage/llm-credentials.js";
import type { RuntimeSocialSessionStatus } from "../../../runtime/protocol/index.js";
import { isRuntimeUnavailableError } from "../../../runtime/protocol/rpc-peer.js";
import {
  IPC_APP_QUIT_FOR_RESTART,
  IPC_AUTH_RUNTIME_REFRESH_COMPLETE,
  IPC_BACKUP_GET_STATUS,
  IPC_BACKUP_LIST,
  IPC_BACKUP_RESTORE,
  IPC_BACKUP_RUN_NOW,
  IPC_SOCIAL_SESSIONS_CREATE,
  IPC_SOCIAL_SESSIONS_GET_STATUS,
  IPC_PERMISSIONS_GET_STATUS,
  IPC_PERMISSIONS_OPEN_SETTINGS,
  IPC_PERMISSIONS_REQUEST,
  IPC_PERMISSIONS_RESET_MICROPHONE,
  IPC_PREFERENCES_GET_SYNC_MODE,
  IPC_PREFERENCES_SET_SYNC_MODE,
  IPC_PREFERENCES_SYNC_MODELS,
  IPC_SOCIAL_SESSIONS_QUEUE_TURN,
  IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
} from "../../src/shared/contracts/ipc-channels.js";
import {
  hasMacPermission,
  clearPermissionCache,
  getMicrophonePermissionStatus,
  requestMacPermission,
  resetMacMicrophonePermissions,
  type MacPermissionKind,
  type MacPermissionSettingsKind,
} from "../utils/macos-permissions.js";
import { waitForConnectedRunner } from "./runtime-availability.js";

import { createRequire } from "node:module";

type ScreenCapturePermissionsModule = {
  hasPromptedForPermission: () => boolean;
  openSystemPreferences: () => Promise<void>;
};

let _screenCapturePermissions: ScreenCapturePermissionsModule | null | undefined;
const getScreenCapturePermissions =
  (): ScreenCapturePermissionsModule | null => {
    if (_screenCapturePermissions !== undefined)
      return _screenCapturePermissions;
    try {
      const req = createRequire(import.meta.url);
      _screenCapturePermissions = req(
        "mac-screen-capture-permissions",
      ) as ScreenCapturePermissionsModule;
    } catch {
      _screenCapturePermissions = null;
    }
    return _screenCapturePermissions;
  };

const screenCapturePermissionsHasPrompted = (
  mod: ScreenCapturePermissionsModule | null,
) => {
  if (!mod) {
    return false;
  }

  try {
    return mod.hasPromptedForPermission();
  } catch {
    return false;
  }
};

const openScreenCaptureSystemPreferences = async (
  mod: ScreenCapturePermissionsModule | null,
) => {
  if (!mod) {
    return false;
  }

  try {
    await mod.openSystemPreferences();
    return true;
  } catch {
    return false;
  }
};

const permissionSettingsUrlByKind: Record<MacPermissionSettingsKind, string> = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  "full-disk-access":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};

const openMacPermissionSettings = async (kind: MacPermissionSettingsKind) => {
  const url = permissionSettingsUrlByKind[kind];
  if (!url) {
    return { opened: false, url: null as string | null };
  }
  await shell.openExternal(url);
  return { opened: true, url };
};

type SystemHandlersOptions = {
  getDeviceId: () => string | null;
  authService: AuthService;
  backupService: BackupService;
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
  getStellaRoot: () => string | null;
  externalLinkService: ExternalLinkService;
  ensurePrivilegedActionApproval: (
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) => Promise<boolean>;
  hardResetLocalState: () => Promise<{ ok: true }>;
  resetLocalMessages: () => Promise<{ ok: true }>;
  shutdownRuntime: () => Promise<void>;
  restartRuntime: () => Promise<void>;
  submitCredential: (payload: {
    requestId: string;
    secretId: string;
    provider: string;
    label: string;
  }) => { ok: boolean; error?: string };
  cancelCredential: (payload: { requestId: string }) => {
    ok: boolean;
    error?: string;
  };
  getBroadcastToMobile?: () =>
    | ((channel: string, data: unknown) => void)
    | null;
  startPhoneAccessSession: () => { ok: boolean };
  stopPhoneAccessSession: () => Promise<{ ok: boolean }>;
  onPermissionGranted?: (kind: MacPermissionKind) => void;
  /** When Accessibility is granted (e.g. user enabled it in System Settings), ensure hooks are running. */
  ensureContextMenuOnMac?: () => void;
};

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const sanitizeStringRecord = (value: unknown): Record<string, string> => {
  const nextRecord: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {},
  )) {
    const trimmedKey = asTrimmedString(key);
    const trimmedValue = asTrimmedString(entryValue);
    if (!trimmedKey || !trimmedValue) {
      continue;
    }
    nextRecord[trimmedKey] = trimmedValue;
  }
  return nextRecord;
};

const createStoppedSocialSessionSnapshot = () => ({
  enabled: false,
  status: "stopped" as const,
  sessionCount: 0,
  sessions: [],
});

const sanitizeOptionalHttpUrl = (value: unknown, fieldName: string) => {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid ${fieldName}.`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Invalid ${fieldName}.`);
  }

  return parsed.toString();
};

const asSocialSessionStatus = (value: unknown): RuntimeSocialSessionStatus => {
  if (value === "active" || value === "paused" || value === "ended") {
    return value;
  }
  throw new Error("Invalid social session status.");
};

export const registerSystemHandlers = (options: SystemHandlersOptions) => {
  ipcMain.handle("device:getId", () => options.getDeviceId());

  ipcMain.handle(IPC_APP_QUIT_FOR_RESTART, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_APP_QUIT_FOR_RESTART,
      )
    ) {
      throw new Error("Blocked untrusted app:quitForRestart request.");
    }
    setTimeout(() => {
      app.quit();
    }, 50);
    return { ok: true };
  });

  ipcMain.handle("phoneAccess:startSession", (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "phoneAccess:startSession",
      )
    ) {
      throw new Error("Blocked untrusted phoneAccess:startSession request.");
    }
    return options.startPhoneAccessSession();
  });

  ipcMain.handle("phoneAccess:stopSession", async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "phoneAccess:stopSession",
      )
    ) {
      throw new Error("Blocked untrusted phoneAccess:stopSession request.");
    }
    return await options.stopPhoneAccessSession();
  });

  ipcMain.handle(
    IPC_SOCIAL_SESSIONS_CREATE,
    async (
      event,
      payload: {
        roomId?: string;
        workspaceLabel?: string;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SOCIAL_SESSIONS_CREATE,
        )
      ) {
        throw new Error("Blocked untrusted socialSessions:create request.");
      }
      const runner = await waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs: 2_000,
        onRunnerChanged: options.onStellaHostRunnerChanged,
      });
      return await runner.createSocialSession({
        roomId: asTrimmedString(payload?.roomId),
        workspaceLabel: asTrimmedString(payload?.workspaceLabel) || undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
    async (
      event,
      payload: {
        sessionId?: string;
        status?: RuntimeSocialSessionStatus;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
        )
      ) {
        throw new Error(
          "Blocked untrusted socialSessions:updateStatus request.",
        );
      }
      const runner = await waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs: 2_000,
        onRunnerChanged: options.onStellaHostRunnerChanged,
      });
      return await runner.updateSocialSessionStatus({
        sessionId: asTrimmedString(payload?.sessionId),
        status: asSocialSessionStatus(payload?.status),
      });
    },
  );

  ipcMain.handle(
    IPC_SOCIAL_SESSIONS_QUEUE_TURN,
    async (
      event,
      payload: {
        sessionId?: string;
        prompt?: string;
        agentType?: string;
        clientTurnId?: string;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_SOCIAL_SESSIONS_QUEUE_TURN,
        )
      ) {
        throw new Error("Blocked untrusted socialSessions:queueTurn request.");
      }
      const runner = await waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs: 2_000,
        onRunnerChanged: options.onStellaHostRunnerChanged,
      });
      return await runner.queueSocialSessionTurn({
        sessionId: asTrimmedString(payload?.sessionId),
        prompt: asTrimmedString(payload?.prompt),
        agentType: asTrimmedString(payload?.agentType) || undefined,
        clientTurnId: asTrimmedString(payload?.clientTurnId) || undefined,
      });
    },
  );

  ipcMain.handle(IPC_SOCIAL_SESSIONS_GET_STATUS, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_SOCIAL_SESSIONS_GET_STATUS,
      )
    ) {
      throw new Error("Blocked untrusted socialSessions:getStatus request.");
    }
    try {
      const runner = await waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs: 2_000,
        onRunnerChanged: options.onStellaHostRunnerChanged,
      });
      return await runner.getSocialSessionStatus();
    } catch (error) {
      if (isRuntimeUnavailableError(error)) {
        return createStoppedSocialSessionSnapshot();
      }
      throw error;
    }
  });

  ipcMain.handle(
    "host:configurePiRuntime",
    (event, config: { convexUrl?: string; convexSiteUrl?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "host:configurePiRuntime",
        )
      ) {
        throw new Error("Blocked untrusted host configuration request.");
      }
      const convexUrl = sanitizeOptionalHttpUrl(config?.convexUrl, "convexUrl");
      const convexSiteUrl = sanitizeOptionalHttpUrl(
        config?.convexSiteUrl,
        "convexSiteUrl",
      );
      if (convexUrl) {
        options.authService.configurePiRuntime({
          convexUrl,
          convexSiteUrl,
        });
      }
      return { deviceId: options.getDeviceId() };
    },
  );

  ipcMain.handle(
    "auth:setState",
    (
      event,
      payload: {
        authenticated?: boolean;
        token?: string;
        hasConnectedAccount?: boolean;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "auth:setState",
        )
      ) {
        throw new Error("Blocked untrusted auth:setState request.");
      }
      options.authService.setHostAuthState(
        Boolean(payload?.authenticated),
        payload?.token,
        payload?.hasConnectedAccount,
      );
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC_AUTH_RUNTIME_REFRESH_COMPLETE,
    (
      event,
      payload: {
        requestId?: string;
        authenticated?: boolean;
        token?: string | null;
        hasConnectedAccount?: boolean;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "auth:runtimeRefreshComplete",
        )
      ) {
        throw new Error("Blocked untrusted auth:runtimeRefreshComplete request.");
      }
      const requestId =
        typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
      if (!requestId) {
        throw new Error("Missing runtime auth refresh request id.");
      }
      return options.authService.completeRuntimeAuthRefresh({
        requestId,
        authenticated: payload?.authenticated,
        token: payload?.token,
        hasConnectedAccount: payload?.hasConnectedAccount,
      });
    },
  );

  ipcMain.handle(
    "host:setCloudSyncEnabled",
    (event, payload: { enabled: boolean }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "host:setCloudSyncEnabled",
        )
      ) {
        throw new Error("Blocked untrusted host:setCloudSyncEnabled request.");
      }
      options
        .getStellaHostRunner()
        ?.setCloudSyncEnabled(Boolean(payload?.enabled));
      return { ok: true };
    },
  );

  ipcMain.handle("app:hardResetLocalState", async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "app:hardResetLocalState",
      )
    ) {
      throw new Error("Blocked untrusted app:hardResetLocalState request.");
    }
    return options.hardResetLocalState();
  });

  ipcMain.handle("app:resetLocalMessages", async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "app:resetLocalMessages",
      )
    ) {
      throw new Error("Blocked untrusted app:resetLocalMessages request.");
    }
    return options.resetLocalMessages();
  });

  ipcMain.handle(
    "credential:submit",
    (
      event,
      payload: {
        requestId: string;
        secretId: string;
        provider: string;
        label: string;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "credential:submit",
        )
      ) {
        throw new Error("Blocked untrusted credential submission.");
      }
      return options.submitCredential(payload);
    },
  );

  ipcMain.handle(
    "credential:cancel",
    (event, payload: { requestId: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "credential:cancel",
        )
      ) {
        throw new Error("Blocked untrusted credential cancellation.");
      }
      return options.cancelCredential(payload);
    },
  );

  ipcMain.on("shell:openExternal", (event, url: string) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "shell:openExternal",
      )
    ) {
      console.debug("[system] blocked untrusted shell:openExternal");
      return;
    }
    const safeUrl = options.externalLinkService.normalizeExternalHttpUrl(url);
    if (!safeUrl) {
      console.debug("[system] rejected invalid URL for shell:openExternal");
      return;
    }
    if (
      !options.externalLinkService.consumeExternalOpenBudget(event.sender.id)
    ) {
      console.debug("[system] shell:openExternal rate limited");
      return;
    }
    void shell.openExternal(safeUrl);
  });

  ipcMain.on("shell:showItemInFolder", (event, filePath: string) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "shell:showItemInFolder",
      )
    ) {
      return;
    }
    if (typeof filePath === "string" && filePath.trim()) {
      shell.showItemInFolder(filePath.trim());
    }
  });

  ipcMain.on("system:openFullDiskAccess", async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "system:openFullDiskAccess",
      )
    ) {
      return;
    }
    const approved = await options.ensurePrivilegedActionApproval(
      "system.open_full_disk_access",
      "Allow Stella to open Full Disk Access settings?",
      "This opens macOS System Settings so Stella can be granted disk access for user-requested tasks.",
      event,
    );
    if (!approved) {
      return;
    }
    if (process.platform === "darwin") {
      import("child_process").then(({ exec: execCmd }) => {
        execCmd(
          'open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"',
        );
      });
    }
  });

  ipcMain.handle(
    "shell:killByPort",
    async (event, payload: { port: number }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "shell:killByPort",
        )
      ) {
        throw new Error("Blocked untrusted shell kill request.");
      }
      const port = Number(payload?.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Invalid port.");
      }
      options.getStellaHostRunner()?.killShellsByPort(port);
    },
  );

  ipcMain.handle(IPC_BACKUP_GET_STATUS, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_BACKUP_GET_STATUS,
      )
    ) {
      throw new Error("Blocked untrusted backup:getStatus request.");
    }
    return await options.backupService.getStatus();
  });

  ipcMain.handle(IPC_BACKUP_RUN_NOW, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_BACKUP_RUN_NOW,
      )
    ) {
      throw new Error("Blocked untrusted backup:runNow request.");
    }
    return await options.backupService.backupNow();
  });

  ipcMain.handle(
    IPC_BACKUP_LIST,
    async (event, payload: { limit?: number } | undefined) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_BACKUP_LIST,
        )
      ) {
        throw new Error("Blocked untrusted backup:list request.");
      }
      const rawLimit = Number(payload?.limit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(50, Math.floor(rawLimit))
          : 25;
      return await options.backupService.listBackups(limit);
    },
  );

  ipcMain.handle(
    IPC_BACKUP_RESTORE,
    async (event, payload: { snapshotId?: string } | undefined) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_BACKUP_RESTORE,
        )
      ) {
        throw new Error("Blocked untrusted backup:restore request.");
      }
      const snapshotId = asTrimmedString(payload?.snapshotId);
      if (!snapshotId) {
        throw new Error("Missing backup snapshot ID.");
      }
      const approved = await options.ensurePrivilegedActionApproval(
        "backup.restore_remote",
        "Restore this backup and restart Stella?",
        "This replaces your current local Stella files with the selected backup, preserves this device's identity and local credentials, and then restarts the app.",
        event,
      );
      if (!approved) {
        throw new Error("Backup restore was cancelled.");
      }
      const result = await options.backupService.restoreBackup(snapshotId, {
        shutdownRuntime: options.shutdownRuntime,
        restartRuntime: options.restartRuntime,
      });
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 500);
      return result;
    },
  );

  ipcMain.handle(IPC_PREFERENCES_GET_SYNC_MODE, (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_GET_SYNC_MODE,
      )
    ) {
      throw new Error("Blocked untrusted preferences:getSyncMode request.");
    }
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) return "off";
    return getSyncMode(stellaRoot);
  });

  ipcMain.handle(IPC_PREFERENCES_SET_SYNC_MODE, (event, mode: string) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PREFERENCES_SET_SYNC_MODE,
      )
    ) {
      throw new Error("Blocked untrusted preferences:setSyncMode request.");
    }
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) return;
    const prefs = loadLocalPreferences(stellaRoot);
    prefs.syncMode = mode === "off" ? "off" : "on";
    saveLocalPreferences(stellaRoot, prefs);
    return options.backupService.setMode(prefs.syncMode);
  });

  ipcMain.handle(
    IPC_PREFERENCES_SYNC_MODELS,
    (
      event,
      payload: {
        defaultModels?: Record<string, string>;
        resolvedDefaultModels?: Record<string, string>;
        modelOverrides?: Record<string, string>;
        generalAgentEngine?: string;
        selfModAgentEngine?: string;
        maxAgentConcurrency?: number;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PREFERENCES_SYNC_MODELS,
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:syncLocalModelPreferences request.",
        );
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) return { ok: true };

      const prefs = loadLocalPreferences(stellaRoot);
      const nextDefaultModels = sanitizeStringRecord(payload?.defaultModels);
      const nextResolvedDefaultModels = sanitizeStringRecord(
        payload?.resolvedDefaultModels,
      );
      const nextOverrides = sanitizeStringRecord(payload?.modelOverrides);

      const generalAgentEngine =
        payload?.generalAgentEngine === "claude_code_local"
          ? payload.generalAgentEngine
          : "default";
      const selfModAgentEngine =
        payload?.selfModAgentEngine === "claude_code_local"
          ? payload.selfModAgentEngine
          : "default";
      const parsedConcurrency = Number(payload?.maxAgentConcurrency);
      const maxAgentConcurrency =
        Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
          ? Math.min(24, Math.floor(parsedConcurrency))
          : 24;

      prefs.defaultModels = nextDefaultModels;
      prefs.resolvedDefaultModels = nextResolvedDefaultModels;
      prefs.modelOverrides = nextOverrides;
      prefs.generalAgentEngine = generalAgentEngine;
      prefs.selfModAgentEngine = selfModAgentEngine;
      prefs.maxAgentConcurrency = maxAgentConcurrency;
      saveLocalPreferences(stellaRoot, prefs);
      return { ok: true };
    },
  );

  ipcMain.handle("llmCredentials:list", (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "llmCredentials:list",
      )
    ) {
      throw new Error("Blocked untrusted credential request.");
    }
    const stellaRoot = options.getStellaRoot();
    if (!stellaRoot) {
      return [];
    }
    return listLocalLlmCredentials(stellaRoot);
  });

  ipcMain.handle(
    "llmCredentials:save",
    (
      event,
      payload: {
        provider?: string;
        label?: string;
        plaintext?: string;
      },
    ) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "llmCredentials:save",
        )
      ) {
        throw new Error("Blocked untrusted credential write.");
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) {
        throw new Error("Local Stella root is unavailable.");
      }
      return saveLocalLlmCredential(stellaRoot, {
        provider: asTrimmedString(payload?.provider),
        label: asTrimmedString(payload?.label),
        plaintext: asTrimmedString(payload?.plaintext),
      });
    },
  );

  ipcMain.handle(
    "llmCredentials:delete",
    (event, payload: { provider?: string }) => {
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          "llmCredentials:delete",
        )
      ) {
        throw new Error("Blocked untrusted credential delete.");
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) {
        return { removed: false };
      }
      return deleteLocalLlmCredential(
        stellaRoot,
        asTrimmedString(payload?.provider),
      );
    },
  );

  let lastAccessibilityStatus = false;

  ipcMain.handle(IPC_PERMISSIONS_GET_STATUS, () => {
    const microphoneStatus = getMicrophonePermissionStatus();
    const microphoneGranted = microphoneStatus === "granted";

    if (process.platform !== "darwin") {
      return {
        accessibility: true,
        screen: true,
        microphone: microphoneGranted,
        microphoneStatus,
      };
    }
    clearPermissionCache();
    const accessibility = hasMacPermission("accessibility", false);
    if (accessibility && !lastAccessibilityStatus) {
      options.onPermissionGranted?.("accessibility");
    }
    lastAccessibilityStatus = accessibility;
    if (accessibility) {
      try {
        options.ensureContextMenuOnMac?.();
      } catch {
        // Best-effort; hooks may still be starting.
      }
    }
    return {
      accessibility,
      screen: hasMacPermission("screen", false),
      microphone: microphoneGranted,
      microphoneStatus,
    };
  });

  ipcMain.handle(IPC_PERMISSIONS_RESET_MICROPHONE, async (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        IPC_PERMISSIONS_RESET_MICROPHONE,
      )
    ) {
      throw new Error(
        "Blocked untrusted permissions:resetMicrophone request.",
      );
    }

    if (process.platform !== "darwin") {
      return { ok: false };
    }

    return { ok: await resetMacMicrophonePermissions() };
  });

  ipcMain.handle(
    IPC_PERMISSIONS_OPEN_SETTINGS,
    async (event, payload: { kind: string }) => {
      const kind = asTrimmedString(payload?.kind) as MacPermissionSettingsKind;
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PERMISSIONS_OPEN_SETTINGS,
        )
      ) {
        throw new Error("Blocked untrusted permissions:openSettings request.");
      }

      if (kind === "microphone" && process.platform === "win32") {
        await shell.openExternal("ms-settings:privacy-microphone");
        return;
      }

      if (process.platform !== "darwin") {
        return;
      }

      await openMacPermissionSettings(kind);
    },
  );

  ipcMain.handle(
    IPC_PERMISSIONS_REQUEST,
    async (event, payload: { kind: string }) => {
      const kind = asTrimmedString(payload?.kind);
      if (
        !options.externalLinkService.assertPrivilegedSender(
          event,
          IPC_PERMISSIONS_REQUEST,
        )
      ) {
        throw new Error("Blocked untrusted permissions:request request.");
      }

      if (kind === "microphone") {
        return { granted: true, alreadyGranted: true };
      }

      if (process.platform !== "darwin") {
        return { granted: true, alreadyGranted: true };
      }

      const macKind = kind as MacPermissionKind;
      if (!["accessibility", "screen"].includes(macKind)) {
        return { granted: false, alreadyGranted: false };
      }

      const result = await requestMacPermission(macKind);
      let openedSettings = false;
      if (macKind === "screen" && !result.granted) {
        try {
          const scp = getScreenCapturePermissions();
          if (screenCapturePermissionsHasPrompted(scp)) {
            const openedViaModule = await openScreenCaptureSystemPreferences(scp);
            if (openedViaModule) {
              openedSettings = true;
            } else {
              const fallback = await openMacPermissionSettings("screen");
              openedSettings = fallback.opened;
            }
          } else {
            const fallback = await openMacPermissionSettings("screen");
            openedSettings = fallback.opened;
          }
        } catch {
          // Best effort only; the renderer can still expose manual settings access.
        }
      }
      if (result.granted && !result.alreadyGranted) {
        options.onPermissionGranted?.(macKind);
      }
      return { ...result, openedSettings };
    },
  );
};
