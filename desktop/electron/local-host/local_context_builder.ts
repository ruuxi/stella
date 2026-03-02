/**
 * Local context builder — assembles AgentContext entirely from disk.
 *
 * Replaces the server-side `fetchAgentContextForRuntime` for everything
 * except proxy token minting. Called in parallel with `mintProxyToken`.
 */

import fs from "fs";
import path from "path";
import { loadAgentsFromHome } from "./agents.js";
import { loadSkillsFromHome } from "./skills.js";
import type { ParsedAgent } from "./manifests.js";
import {
  getModelOverride,
  getExpressionStyle,
  getGeneralAgentEngine,
  getCodexLocalMaxConcurrency,
} from "./local_preferences.js";
import type { AgentContext } from "./agent_runtime.js";

// ── Model defaults (mirrors backend/convex/agent/model.ts) ───────────────

type ModelDefaults = { model: string; fallback?: string };

const DEFAULT_MODEL: ModelDefaults = {
  model: "anthropic/claude-opus-4.6",
  fallback: "moonshotai/kimi-k2.5",
};

const AGENT_MODELS: Record<string, ModelDefaults> = {
  orchestrator: { model: "anthropic/claude-opus-4.6", fallback: "anthropic/claude-opus-4.5" },
  general: { model: "anthropic/claude-opus-4.6", fallback: "anthropic/claude-opus-4.5" },
  explore: { model: "zai/glm-4.7", fallback: "moonshotai/kimi-k2.5" },
  browser: { model: "moonshotai/kimi-k2.5", fallback: "anthropic/claude-sonnet-4-5" },
  self_mod: { model: "anthropic/claude-opus-4.6", fallback: "anthropic/claude-opus-4.5" },
};

const getModelDefaults = (agentType: string): ModelDefaults =>
  AGENT_MODELS[agentType] ?? DEFAULT_MODEL;

// ── Skills disabled for certain agent types ──────────────────────────────

const SKILLS_DISABLED_AGENT_TYPES = new Set(["explore", "memory"]);

// ── Prompt building helpers (ported from backend/convex/agent/prompt_builder.ts) ──

const getPlatformGuidance = (platform: string): string => {
  if (platform === "win32") {
    return `
## Platform: Windows

You are running on Windows. Use Windows-compatible commands:
- Shell: Git Bash (bash syntax works)
- Open apps: \`start <app>\` or \`cmd /c start "" <app>\` (NOT \`open -a\`)
- Open URLs: \`start <url>\`
- File paths: Use forward slashes in bash, or escape backslashes
- Common paths: \`$USERPROFILE\` (home), \`$APPDATA\`, \`$LOCALAPPDATA\``.trim();
  }

  if (platform === "darwin") {
    return `
## Platform: macOS

You are running on macOS. Use macOS-compatible commands:
- Shell: bash/zsh
- Open apps: \`open -a <app>\`
- Open URLs: \`open <url>\`
- Common paths: \`$HOME\`, \`~/Library/Application Support\``.trim();
  }

  if (platform === "linux") {
    return `
## Platform: Linux

You are running on Linux. Use Linux-compatible commands:
- Shell: bash
- Open apps: \`xdg-open\` or app-specific launchers
- Open URLs: \`xdg-open <url>\`
- Common paths: \`$HOME\`, \`~/.config\`, \`~/.local/share\``.trim();
  }

  return "";
};

const buildSkillsSection = (
  skills: Array<{
    id: string;
    name: string;
    description: string;
    execution?: string;
    requiresSecrets?: string[];
    publicIntegration?: boolean;
    secretMounts?: Record<string, unknown>;
  }>,
): string => {
  if (skills.length === 0) return "";

  const lines = skills.map((skill) => {
    const tags: string[] = [];
    if (skill.publicIntegration) tags.push("public");
    if (skill.requiresSecrets && skill.requiresSecrets.length > 0) tags.push("requires credentials");
    if (skill.execution === "backend") tags.push("backend-only");
    if (skill.execution === "device") tags.push("device-only");
    if (skill.secretMounts) tags.push("has secret mounts");
    const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    return `- **${skill.name}** (${skill.id}): ${skill.description}${suffix} Activate skill.`;
  });

  return [
    "# Skills",
    "Skills are listed by name and description only. Use ActivateSkill to load a skill's full instructions when needed.",
    "",
    ...lines,
  ].join("\n");
};

// ── Core memory reader ───────────────────────────────────────────────────

const readCoreMemory = (stellaHome: string): string | undefined => {
  const filePath = path.join(stellaHome, "state", "CORE_MEMORY.MD");
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
};

// ── Agent config resolver ────────────────────────────────────────────────

const findAgentConfig = (
  agents: ParsedAgent[],
  agentType: string,
): ParsedAgent | undefined => {
  // User-defined agents override builtins: the local disk always contains
  // the merged set (builtins are synced as markdown from backend on startup).
  return agents.find((a) => a.agentTypes.includes(agentType) || a.id === agentType);
};

// ── Main builder ─────────────────────────────────────────────────────────

export type BuildLocalContextOpts = {
  stellaHome: string;
  agentType: string;
  conversationId?: string;
  platform?: string;
  timezone?: string;
  /** Override thread history for local mode where threads are managed differently */
  threadHistory?: Array<{ role: string; content: string; toolCallId?: string }>;
  activeThreadId?: string;
};

export type LocalContextResult = Omit<AgentContext, "proxyToken">;

/**
 * Builds everything that fetchAgentContextForRuntime returned, EXCEPT
 * the proxy token (which must come from the server). Called in parallel
 * with mintProxyToken to halve the pre-turn latency.
 */
export const buildAgentContextLocally = async (
  opts: BuildLocalContextOpts,
): Promise<LocalContextResult> => {
  const {
    stellaHome,
    agentType,
    platform,
    timezone,
  } = opts;

  const agentsPath = path.join(stellaHome, "agents");
  const skillsPath = path.join(stellaHome, "skills");

  // Load agents + skills from disk (fast FS reads)
  const [agents, allSkills] = await Promise.all([
    loadAgentsFromHome(agentsPath),
    SKILLS_DISABLED_AGENT_TYPES.has(agentType)
      ? Promise.resolve([])
      : loadSkillsFromHome(skillsPath),
  ]);

  // Resolve agent config
  const agentConfig = findAgentConfig(agents, agentType);
  const systemPromptBase = agentConfig?.systemPrompt ?? "";
  const toolsAllowlist = agentConfig?.toolsAllowlist;
  const maxTaskDepthValue = Number(agentConfig?.maxTaskDepth ?? 2);
  const maxTaskDepth = Number.isFinite(maxTaskDepthValue) && maxTaskDepthValue >= 0
    ? Math.floor(maxTaskDepthValue)
    : 2;
  const defaultSkills = agentConfig?.defaultSkills ?? [];

  // Filter skills for this agent type
  const skills = allSkills.filter(
    (s) => s.enabled !== false && (s.agentTypes.length === 0 || s.agentTypes.includes(agentType)),
  );
  const skillIds = skills.map((s) => s.id);

  // Build system prompt
  const systemParts = [systemPromptBase];

  // Skills section
  const skillsSection = buildSkillsSection(
    skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      execution: s.execution,
      requiresSecrets: s.requiresSecrets,
      publicIntegration: s.publicIntegration,
      secretMounts: s.secretMounts as Record<string, unknown> | undefined,
    })),
  );
  if (skillsSection) systemParts.push(skillsSection);

  // Platform guidance
  if (platform) {
    const guidance = getPlatformGuidance(platform);
    if (guidance) systemParts.push(guidance);
  }

  // Expression style
  if (agentType === "orchestrator") {
    const style = getExpressionStyle(stellaHome);
    if (style === "none") {
      systemParts.push("The user prefers responses without emoji.");
    } else if (style === "emoji") {
      systemParts.push("The user prefers responses with emoji.");
    }
  }

  // Core memory
  if (agentType === "orchestrator") {
    const coreMemory = readCoreMemory(stellaHome);
    if (coreMemory) {
      systemParts.push(`\n\n# User Profile\n${coreMemory}`);
    }
  }

  // Dynamic context
  const dynamicParts: string[] = [];
  if (agentType === "orchestrator") {
    const tz = timezone ?? "UTC";
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: tz,
    });
    dynamicParts.push(`Today is ${dateStr}.`);
  }

  // Resolve model
  const modelDefaults = getModelDefaults(agentType);
  const modelOverride = getModelOverride(stellaHome, agentType);
  const model = modelOverride ?? modelDefaults.model;

  // General agent engine
  let generalAgentEngine: "default" | "codex_local" | "claude_code_local" | undefined;
  let codexLocalMaxConcurrency: number | undefined;
  if (agentType === "general") {
    generalAgentEngine = getGeneralAgentEngine(stellaHome);
    codexLocalMaxConcurrency = getCodexLocalMaxConcurrency(stellaHome);
  }

  const coreMemory = readCoreMemory(stellaHome);

  return {
    systemPrompt: systemParts.join("\n\n").trim(),
    dynamicContext: dynamicParts.join("\n\n").trim(),
    toolsAllowlist,
    model,
    fallbackModel: modelDefaults.fallback,
    maxTaskDepth,
    defaultSkills,
    skillIds,
    coreMemory,
    threadHistory: opts.threadHistory,
    activeThreadId: opts.activeThreadId,
    generalAgentEngine,
    codexLocalMaxConcurrency,
  };
};
