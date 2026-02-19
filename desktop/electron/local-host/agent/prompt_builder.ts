/**
 * Local prompt builder — constructs system prompts from SQLite data.
 * Ported from backend/convex/agent/prompt_builder.ts
 */

import { rawQuery } from "../db.js";

export type PromptBuildResult = {
  systemPrompt: string;
  dynamicContext: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  defaultSkills: string[];
  skillIds: string[];
};

const SKILLS_DISABLED_AGENT_TYPES = new Set(["explore", "memory"]);
const MAX_ACTIVE_THREADS_IN_PROMPT = 12;

type SkillRow = {
  id: string;
  skill_id: string;
  name: string;
  description: string;
  execution?: string;
  requires_secrets?: string | string[];
  public_integration?: number;
  secret_mounts?: string | Record<string, unknown>;
};

type AgentRow = {
  id: string;
  agent_id: string;
  name: string;
  system_prompt: string;
  agent_types: string | string[];
  tools_allowlist?: string | string[];
  default_skills?: string | string[];
  max_task_depth?: number;
};

function parseJsonArray(val: unknown): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return []; }
  }
  return [];
}

function buildSkillsSection(
  skills: Array<{
    id: string;
    name: string;
    description: string;
    execution?: string;
    requiresSecrets?: string[];
    publicIntegration?: boolean;
    secretMounts?: Record<string, unknown>;
  }>,
): string {
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
}

export function buildSystemPrompt(
  agentType: string,
  options?: { ownerId?: string; conversationId?: string },
): PromptBuildResult {
  const ownerId = options?.ownerId || "local";

  // Load agent config
  const agents = rawQuery<AgentRow>(
    "SELECT * FROM agents WHERE (owner_id = ? OR owner_id IS NULL) AND agent_types LIKE ? ORDER BY updated_at DESC LIMIT 1",
    [ownerId, `%"${agentType}"%`],
  );

  const agent = agents[0];
  const systemPrompt = agent?.system_prompt || `You are Stella, an AI assistant. You are operating as the "${agentType}" agent.`;
  const toolsAllowlist = agent ? parseJsonArray(agent.tools_allowlist) : undefined;
  const defaultSkills = agent ? parseJsonArray(agent.default_skills) : [];
  const maxTaskDepthRaw = agent?.max_task_depth ?? 2;
  const maxTaskDepth = Number.isFinite(maxTaskDepthRaw) && maxTaskDepthRaw > 0
    ? Math.floor(maxTaskDepthRaw)
    : 2;

  // Load enabled skills
  let skills: SkillRow[] = [];
  if (!SKILLS_DISABLED_AGENT_TYPES.has(agentType)) {
    skills = rawQuery<SkillRow>(
      `SELECT * FROM skills
       WHERE (owner_id = ? OR owner_id IS NULL)
         AND enabled = 1
         AND agent_types LIKE ?
       ORDER BY updated_at DESC`,
      [ownerId, `%"${agentType}"%`],
    );
  }

  const skillsSection = buildSkillsSection(
    skills.map((s) => ({
      id: s.skill_id,
      name: s.name,
      description: s.description,
      execution: s.execution,
      requiresSecrets: parseJsonArray(s.requires_secrets),
      publicIntegration: s.public_integration === 1,
      secretMounts: typeof s.secret_mounts === "string"
        ? (() => { try { return JSON.parse(s.secret_mounts); } catch { return undefined; } })()
        : s.secret_mounts as Record<string, unknown> | undefined,
    })),
  );

  const systemParts = [systemPrompt];
  if (skillsSection) systemParts.push(skillsSection);

  // Dynamic context
  const dynamicParts: string[] = [];

  // Device status for orchestrator (always online in local mode)
  if (agentType === "orchestrator") {
    dynamicParts.push([
      "# Device Status",
      "- Local device (desktop app): online",
      "- Remote machine: not provisioned",
    ].join("\n"));
  }

  // Active threads for orchestrator
  if (agentType === "orchestrator" && options?.conversationId) {
    try {
      const threads = rawQuery<{
        id: string;
        name: string;
        message_count: number;
        last_used_at: number;
      }>(
        "SELECT * FROM threads WHERE conversation_id = ? AND status = 'active' ORDER BY last_used_at DESC LIMIT ?",
        [options.conversationId, MAX_ACTIVE_THREADS_IN_PROMPT],
      );

      if (threads.length > 0) {
        const lines = threads.map((t) => {
          const ageMs = Date.now() - t.last_used_at;
          const age = ageMs < 60_000 ? "just now"
            : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago`
            : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago`
            : `${Math.floor(ageMs / 86_400_000)}d ago`;
          return `- **${t.name}** (id: ${t.id}) — ${t.message_count} msgs, last used ${age}`;
        });
        dynamicParts.push(
          `# Active Threads\nContinue with thread_id, or create new with thread_name.\n${lines.join("\n")}`,
        );
      }
    } catch {
      // Thread query failed — skip
    }
  }

  // Expression style preference
  if (agentType === "orchestrator") {
    try {
      const prefs = rawQuery<{ value: string }>(
        "SELECT value FROM user_preferences WHERE owner_id = ? AND key = 'expression_style'",
        [ownerId],
      );
      if (prefs.length > 0) {
        if (prefs[0].value === "none") {
          dynamicParts.push("The user prefers responses without emoji.");
        } else if (prefs[0].value === "emoji") {
          dynamicParts.push("The user prefers responses with emoji.");
        }
      }
    } catch {}
  }

  return {
    systemPrompt: systemParts.join("\n\n").trim(),
    dynamicContext: dynamicParts.join("\n\n").trim(),
    toolsAllowlist: toolsAllowlist && toolsAllowlist.length > 0 ? toolsAllowlist : undefined,
    maxTaskDepth,
    defaultSkills,
    skillIds: skills.map((s) => s.skill_id),
  };
}
