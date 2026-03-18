import {
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  getSyncMode,
  loadLocalPreferences,
  saveLocalPreferences,
} from "../core/runtime/preferences/local-preferences.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import type { AuthService } from "../services/auth-service.js";
import type { ExternalLinkService } from "../services/external-link-service.js";
import type { SocialSessionService } from "../services/social-session-service.js";
import {
  deleteLocalLlmCredential,
  listLocalLlmCredentials,
  saveLocalLlmCredential,
} from "../core/runtime/storage/llm-credentials.js";

type SystemHandlersOptions = {
  getDeviceId: () => string | null;
  authService: AuthService;
  getStellaHostRunner: () => StellaHostRunner | null;
  getStellaHomePath: () => string | null;
  socialSessionService: SocialSessionService;
  externalLinkService: ExternalLinkService;
  ensurePrivilegedActionApproval: (
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) => Promise<boolean>;
  hardResetLocalState: () => Promise<{ ok: true }>;
  resetLocalMessages: () => Promise<{ ok: true }>;
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
};

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

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

export const registerSystemHandlers = (options: SystemHandlersOptions) => {
  ipcMain.handle("device:getId", () => options.getDeviceId());

  ipcMain.handle("socialSessions:getStatus", (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "socialSessions:getStatus",
      )
    ) {
      throw new Error("Blocked untrusted socialSessions:getStatus request.");
    }
    return options.socialSessionService.getSnapshot();
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
        options.socialSessionService.setConvexUrl(convexUrl);
      }
      return { deviceId: options.getDeviceId() };
    },
  );

  ipcMain.handle(
    "auth:setState",
    (event, payload: { authenticated?: boolean; token?: string }) => {
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
      );
      options.socialSessionService.setAuthToken(
        Boolean(payload?.authenticated) ? payload?.token ?? null : null,
      );
      return { ok: true };
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

  ipcMain.handle("preferences:getSyncMode", (event) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "preferences:getSyncMode",
      )
    ) {
      throw new Error("Blocked untrusted preferences:getSyncMode request.");
    }
    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath) return "off";
    return getSyncMode(stellaHomePath);
  });

  ipcMain.handle("preferences:setSyncMode", (event, mode: string) => {
    if (
      !options.externalLinkService.assertPrivilegedSender(
        event,
        "preferences:setSyncMode",
      )
    ) {
      throw new Error("Blocked untrusted preferences:setSyncMode request.");
    }
    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath) return;
    const prefs = loadLocalPreferences(stellaHomePath);
    prefs.syncMode = mode === "off" ? "off" : "on";
    saveLocalPreferences(stellaHomePath, prefs);
  });

  ipcMain.handle(
    "preferences:syncLocalModelPreferences",
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
          "preferences:syncLocalModelPreferences",
        )
      ) {
        throw new Error(
          "Blocked untrusted preferences:syncLocalModelPreferences request.",
        );
      }
      const stellaHomePath = options.getStellaHomePath();
      if (!stellaHomePath) return { ok: true };

      const prefs = loadLocalPreferences(stellaHomePath);
      const nextDefaultModels: Record<string, string> = {};
      for (const [agentType, model] of Object.entries(
        payload?.defaultModels ?? {},
      )) {
        const trimmedAgentType = asTrimmedString(agentType);
        const trimmedModel = asTrimmedString(model);
        if (!trimmedAgentType || !trimmedModel) {
          continue;
        }
        nextDefaultModels[trimmedAgentType] = trimmedModel;
      }
      const nextResolvedDefaultModels: Record<string, string> = {};
      for (const [agentType, model] of Object.entries(
        payload?.resolvedDefaultModels ?? {},
      )) {
        const trimmedAgentType = asTrimmedString(agentType);
        const trimmedModel = asTrimmedString(model);
        if (!trimmedAgentType || !trimmedModel) {
          continue;
        }
        nextResolvedDefaultModels[trimmedAgentType] = trimmedModel;
      }
      const nextOverrides: Record<string, string> = {};
      for (const [agentType, model] of Object.entries(
        payload?.modelOverrides ?? {},
      )) {
        const trimmedAgentType = asTrimmedString(agentType);
        const trimmedModel = asTrimmedString(model);
        if (!trimmedAgentType || !trimmedModel) {
          continue;
        }
        nextOverrides[trimmedAgentType] = trimmedModel;
      }

      const generalAgentEngine =
        payload?.generalAgentEngine === "claude_code_local"
          ? payload.generalAgentEngine
          : "default";
      const selfModAgentEngine =
        payload?.selfModAgentEngine === "claude_code_local"
          ? payload.selfModAgentEngine
          : "default";
      const parsedConcurrency = Number(payload?.maxAgentConcurrency);
      const maxAgentConcurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
        ? Math.min(24, Math.floor(parsedConcurrency))
        : 24;

      prefs.defaultModels = nextDefaultModels;
      prefs.resolvedDefaultModels = nextResolvedDefaultModels;
      prefs.modelOverrides = nextOverrides;
      prefs.generalAgentEngine = generalAgentEngine;
      prefs.selfModAgentEngine = selfModAgentEngine;
      prefs.maxAgentConcurrency = maxAgentConcurrency;
      saveLocalPreferences(stellaHomePath, prefs);
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
    const stellaHomePath = options.getStellaHomePath();
    if (!stellaHomePath) {
      return [];
    }
    return listLocalLlmCredentials(stellaHomePath);
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
      const stellaHomePath = options.getStellaHomePath();
      if (!stellaHomePath) {
        throw new Error("Local Stella home is unavailable.");
      }
      return saveLocalLlmCredential(stellaHomePath, {
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
      const stellaHomePath = options.getStellaHomePath();
      if (!stellaHomePath) {
        return { removed: false };
      }
      return deleteLocalLlmCredential(
        stellaHomePath,
        asTrimmedString(payload?.provider),
      );
    },
  );
};
