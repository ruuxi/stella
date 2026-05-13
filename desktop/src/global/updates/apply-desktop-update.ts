import { AGENT_IDS } from "../../../../runtime/contracts/agent-runtime.js";
import { getDeviceIdOrNull } from "@/platform/electron/device";
import type {
  AgentStreamIpcEvent,
  InstallManifestSnapshot,
} from "@/shared/types/electron";

const DEFAULT_REPO_OWNER = "ruuxi";
const DEFAULT_REPO_NAME = "stella";

export type ActiveDesktopUpdate = {
  status: "starting" | "running";
  conversationId: string;
  requestId?: string;
  runId?: string;
  targetCommit: string;
  targetTag: string;
};

let activeDesktopUpdate: ActiveDesktopUpdate | null = null;
const activeDesktopUpdateListeners = new Set<() => void>();

const emitActiveDesktopUpdateChange = () => {
  for (const listener of activeDesktopUpdateListeners) {
    listener();
  }
};

const setActiveDesktopUpdate = (next: ActiveDesktopUpdate | null) => {
  activeDesktopUpdate = next;
  emitActiveDesktopUpdateChange();
};

export const getActiveDesktopUpdate = (): ActiveDesktopUpdate | null =>
  activeDesktopUpdate;

export const subscribeActiveDesktopUpdate = (listener: () => void) => {
  activeDesktopUpdateListeners.add(listener);
  return () => {
    activeDesktopUpdateListeners.delete(listener);
  };
};

export const cancelActiveDesktopUpdate = (): boolean => {
  const runId = activeDesktopUpdate?.runId;
  if (!runId) return false;
  window.electronAPI?.agent?.cancelChat?.(runId);
  return true;
};

type ApplyDesktopUpdateOptions = {
  installManifest: InstallManifestSnapshot;
  publishedCommit: string;
  publishedTag: string;
  publishedAt: number;
  onAppliedCommit?: (
    manifest: InstallManifestSnapshot | null,
  ) => void | Promise<void>;
  onFinished?: (event: AgentStreamIpcEvent) => void;
};

type ApplyDesktopUpdateResult = {
  requestId: string;
  conversationId: string;
  cancel: () => boolean;
};

/**
 * Spawn the install-update agent in its own conversation thread.
 *
 * The agent receives a hidden user prompt with the upstream commit
 * range and the install root; the system prompt baked into
 * `runtime/extensions/stella-runtime/agents/install_update.md` covers
 * the apply loop and conflict handling.
 */
export const applyDesktopUpdate = async (
  options: ApplyDesktopUpdateOptions,
): Promise<ApplyDesktopUpdateResult | null> => {
  const electronApi = window.electronAPI;
  if (!electronApi?.agent?.startChat) {
    throw new Error("Stella runtime is not available.");
  }
  if (
    !electronApi.agent.onStream ||
    !electronApi.updates?.recordAppliedCommit
  ) {
    throw new Error("Stella update tracking is not available.");
  }
  if (activeDesktopUpdate) {
    throw new Error("A Stella update is already running.");
  }

  const baseCommit =
    options.installManifest.desktopReleaseCommit ??
    options.installManifest.desktopInstallBaseCommit;
  if (!baseCommit) {
    throw new Error(
      "This install is missing a base commit reference. Reinstall is required before updates can be tracked.",
    );
  }

  const conversationId = `install-update-${crypto.randomUUID()}`;
  const repoOwner = DEFAULT_REPO_OWNER;
  const repoName = DEFAULT_REPO_NAME;
  setActiveDesktopUpdate({
    status: "starting",
    conversationId,
    targetCommit: options.publishedCommit,
    targetTag: options.publishedTag,
  });

  const prompt = [
    "You are the install-update agent. Apply the upstream change set below.",
    "",
    `Repository: ${repoOwner}/${repoName}`,
    `Base commit (currently installed): ${baseCommit}`,
    `Target commit (latest published): ${options.publishedCommit}`,
    `Release tag: ${options.publishedTag}`,
    `Install root: ${options.installManifest.installPath}`,
    "",
    "Walk the GitHub compare API and apply each in-scope file change. Follow the system prompt for scope, conflicts, and the apply order.",
    "When finished, report which files updated cleanly, which were merged with local edits, and which were skipped.",
  ].join("\n");

  const platform = electronApi.platform ?? "darwin";
  const timezone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC";
  const deviceId = (await getDeviceIdOrNull()) ?? "";

  // Subscribe BEFORE startChat so we don't miss a fast-completing run.
  // On a successful RUN_FINISHED for this install-update conversation,
  // persist the applied commit into the launcher manifest. The
  // subscription auto-cleans on terminal outcome.
  let unsubscribe: (() => void) | null = null;
  unsubscribe = electronApi.agent.onStream((event) => {
    if (
      event.type === "run-started" &&
      event.conversationId === conversationId &&
      event.agentType === AGENT_IDS.INSTALL_UPDATE
    ) {
      if (activeDesktopUpdate?.conversationId === conversationId) {
        setActiveDesktopUpdate({
          ...activeDesktopUpdate,
          status: "running",
          runId: event.runId,
        });
      }
      return;
    }
    if (
      event.type !== "run-finished" ||
      event.conversationId !== conversationId ||
      event.agentType !== AGENT_IDS.INSTALL_UPDATE
    ) {
      return;
    }
    void (async () => {
      // The agent's "completed" outcome only means the agent thread finished
      // without crashing — it does NOT prove the merge actually landed.
      // `recordAppliedCommit` verifies HEAD against the target commit using
      // git itself; on failure we synthesize an "error" event so the UI
      // surfaces the real outcome instead of silently bumping the manifest.
      let effectiveEvent: AgentStreamIpcEvent = event;
      try {
        if (event.outcome === "completed") {
          const manifest = await electronApi.updates.recordAppliedCommit(
            options.publishedCommit,
            options.publishedTag,
          );
          await options.onAppliedCommit?.(manifest);
        }
      } catch (err) {
        const reason =
          (err as Error)?.message ??
          "Stella couldn't verify the update landed in the install tree.";
        console.warn("[install-update] Verification failed:", err);
        effectiveEvent = {
          ...event,
          outcome: "error",
          reason,
          error: reason,
        };
      } finally {
        options.onFinished?.(effectiveEvent);
        if (activeDesktopUpdate?.conversationId === conversationId) {
          setActiveDesktopUpdate(null);
        }
        unsubscribe?.();
        unsubscribe = null;
      }
    })();
  });

  try {
    const result = await electronApi.agent.startChat({
      conversationId,
      userPrompt: prompt,
      deviceId,
      platform,
      timezone,
      agentType: AGENT_IDS.INSTALL_UPDATE,
      storageMode: "local",
      messageMetadata: {
        installUpdate: {
          baseCommit,
          targetCommit: options.publishedCommit,
          targetTag: options.publishedTag,
          publishedAt: options.publishedAt,
          installRoot: options.installManifest.installPath,
          repoOwner,
          repoName,
        },
      },
    });
    const currentActiveUpdate = getActiveDesktopUpdate();
    if (currentActiveUpdate?.conversationId === conversationId) {
      setActiveDesktopUpdate({
        ...currentActiveUpdate,
        requestId: result.requestId,
      });
    }
    return {
      requestId: result.requestId,
      conversationId,
      cancel: cancelActiveDesktopUpdate,
    };
  } catch (err) {
    if (getActiveDesktopUpdate()?.conversationId === conversationId) {
      setActiveDesktopUpdate(null);
    }
    unsubscribe?.();
    throw err;
  }
};
