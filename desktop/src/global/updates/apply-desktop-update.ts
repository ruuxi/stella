import { AGENT_IDS } from "../../../../runtime/contracts/agent-runtime.js";
import { getDeviceIdOrNull } from "@/platform/electron/device";
import type {
  AgentStreamIpcEvent,
  InstallManifestSnapshot,
} from "@/shared/types/electron";

const DEFAULT_REPO_OWNER = "ruuxi";
const DEFAULT_REPO_NAME = "stella";
let activeInstallUpdateConversationId: string | null = null;

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
  if (activeInstallUpdateConversationId) {
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
  activeInstallUpdateConversationId = conversationId;
  const repoOwner = DEFAULT_REPO_OWNER;
  const repoName = DEFAULT_REPO_NAME;

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
  let activeRunId: string | null = null;
  unsubscribe = electronApi.agent.onStream((event) => {
    if (
      event.type === "run-started" &&
      event.conversationId === conversationId &&
      event.agentType === AGENT_IDS.INSTALL_UPDATE
    ) {
      activeRunId = event.runId;
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
      try {
        if (event.outcome === "completed") {
          const manifest = await electronApi.updates.recordAppliedCommit(
            options.publishedCommit,
          );
          await options.onAppliedCommit?.(manifest);
        }
      } catch (err) {
        console.warn("[install-update] Failed to record applied commit:", err);
      } finally {
        options.onFinished?.(event);
        if (activeInstallUpdateConversationId === conversationId) {
          activeInstallUpdateConversationId = null;
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
    return {
      requestId: result.requestId,
      conversationId,
      cancel: () => {
        if (!activeRunId) {
          return false;
        }
        electronApi.agent.cancelChat(activeRunId);
        return true;
      },
    };
  } catch (err) {
    if (activeInstallUpdateConversationId === conversationId) {
      activeInstallUpdateConversationId = null;
    }
    unsubscribe?.();
    throw err;
  }
};
