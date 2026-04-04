import fs from "fs";
import path from "path";
import {
  TASK_SHUTDOWN_CANCEL_REASON,
  type TaskLifecycleEvent,
} from "../tasks/local-task-manager.js";
import { LOCAL_CONTEXT_EVENT_TYPES } from "../local-history.js";
import {
  managedMediaDocsUrlFromConvexSiteUrl as buildManagedMediaDocsUrl,
  readConfiguredConvexUrl as sanitizeConvexDeploymentUrl,
  readConfiguredStellaBaseUrl as sanitizeStellaBase,
} from "../convex-urls.js";
import { isOrchestratorAgentType } from "../../../src/shared/contracts/agent-runtime.js";
import type { SelfModHmrState } from "../../contracts/index.js";

export const DEFAULT_MAX_TASK_DEPTH = 8;
export const LOCAL_HISTORY_RESERVE_TOKENS = 16_384;
export const MIN_LOCAL_HISTORY_TOKENS = 8_000;
export const DEFAULT_ORCHESTRATOR_PROMPT =
  "You are Stella's orchestrator. Coordinate specialized work and keep work non-blocking by default. " +
  "For user-facing output, prefer Display for most substantive, structured, or multi-item responses and keep plain text mainly for acknowledgments, brief confirmations, and short replies. " +
  "After using Display, keep any chat text to one short sentence unless the user explicitly asks for detailed text. " +
  'You can interact with Stella\'s desktop UI via `stella-ui snapshot`, `stella-ui click @ref`, `stella-ui fill @ref "text"` in Bash.';
export const DEFAULT_SUBAGENT_PROMPT =
  "You are a Stella sub-agent. Execute delegated work directly, provide concise progress, and run tools safely. " +
  "When creating or modifying UI components, add data-stella-label, data-stella-state, and data-stella-action attributes.";
export {
  LOCAL_CONTEXT_EVENT_TYPES,
  sanitizeConvexDeploymentUrl,
  sanitizeStellaBase,
  buildManagedMediaDocsUrl,
};
export const QUEUED_TURN_INTERRUPT_ERROR =
  "Interrupted by queued orchestrator turn";

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const defaultPromptForAgentType = (agentType: string): string => {
  if (isOrchestratorAgentType(agentType)) return DEFAULT_ORCHESTRATOR_PROMPT;
  return DEFAULT_SUBAGENT_PROMPT;
};

export const buildManagedMediaDocsPrompt = (
  convexDeploymentUrl: string | null | undefined,
): string => {
  const siteUrl = sanitizeConvexDeploymentUrl(convexDeploymentUrl ?? null);
  const docsUrl = siteUrl ? buildManagedMediaDocsUrl(siteUrl) : null;
  if (!docsUrl) return "";

  return [
    "Managed backend media SDK:",
    `- Latest docs: ${docsUrl}`,
    `- Before wiring media generation or media analysis features, fetch the live docs with \`curl -L "${docsUrl}"\` so you use the latest backend contract and examples.`,
    "- Docs are public, but media generation and job polling still require Stella auth from the client.",
  ].join("\n");
};

export const buildPanelInventory = (frontendRoot: string): string => {
  const labelPattern = /data-stella-label="([^"]+)"/g;
  const labels = new Set<string>();
  const homeDir = path.join(frontendRoot, "src", "app", "home");
  const pagesDir = path.join(frontendRoot, "src", "views", "home", "pages");

  for (const dir of [homeDir, pagesDir]) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (!/\.(tsx|jsx)$/.test(entry)) continue;
        try {
          const source = fs.readFileSync(path.join(dir, entry), "utf-8");
          let match: RegExpExecArray | null;
          while ((match = labelPattern.exec(source)) !== null) {
            labels.add(match[1]);
          }
        } catch {
          // Skip unreadable files.
        }
      }
    } catch {
      // Directory doesn't exist.
    }
  }

  if (labels.size === 0) return "";
  return (
    "Current panels on the home view (visible to the user right now): " +
    [...labels].join(", ")
  );
};

export const readCoreMemory = (stellaHome: string): string | undefined => {
  const filePath = path.join(stellaHome, "state", "CORE_MEMORY.MD");
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
};

export const buildTaskEventPrompt = (
  event: TaskLifecycleEvent,
): string | null => {
  if (
    event.type !== "task-completed" &&
    event.type !== "task-failed" &&
    event.type !== "task-canceled"
  ) {
    return null;
  }

  const lines =
    event.type === "task-completed"
      ? ["[Task completed]"]
      : event.type === "task-canceled"
        ? ["[Task canceled]"]
        : ["[Task failed]"];

  if (event.taskId) lines.push(`thread_id: ${event.taskId}`);
  if (event.agentType) lines.push(`agent_type: ${event.agentType}`);
  if (event.description) lines.push(`description: ${event.description}`);
  if (
    event.type === "task-canceled"
    && event.error === TASK_SHUTDOWN_CANCEL_REASON
  ) {
    return null;
  }
  if (event.type === "task-completed" && event.result) {
    lines.push(`result: ${event.result}`);
  }
  if (
    (event.type === "task-failed" || event.type === "task-canceled") &&
    event.error
  ) {
    lines.push(`error: ${event.error}`);
  }

  return lines.join("\n");
};

export const createSelfModHmrState = (
  phase: SelfModHmrState["phase"],
  paused: boolean,
  requiresFullReload = false,
): SelfModHmrState => ({
  phase,
  paused,
  requiresFullReload,
});
