import { agentHasCapability } from "../../../contracts/agent-runtime.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { readOrSeedPersonality } from "../../../kernel/personality/personality.js";
import { getPersonalityVoiceId } from "../../../kernel/preferences/local-preferences.js";

const PERSONALITY_MARKER = "<!-- personality -->";

/**
 * Personality injection hook (stella-runtime).
 *
 * Reads the user's selected personality voice from local preferences and
 * either substitutes the `<!-- personality -->` marker in the system
 * prompt or prepends the personality block, then returns the new prompt
 * as `systemPromptReplace`.
 *
 * Gated by the `injectsPersonality` agent capability rather than a
 * literal `agentType === "orchestrator"` check, so future agents that
 * opt into the capability inherit the behavior with no engine edits.
 * Today only the orchestrator declares the flag (see
 * `BUILTIN_AGENT_DEFINITIONS`).
 *
 * Lives in the stella-runtime extension instead of the kernel so users
 * can fork the personality logic in place. The `stellaHome` it closes
 * over is supplied by the extension factory's services arg.
 */
export const createPersonalityHook = (opts: {
  stellaHome: string;
}): HookDefinition<"before_agent_start"> => ({
  event: "before_agent_start",
  async handler(payload) {
    if (!agentHasCapability(payload.agentType, "injectsPersonality")) {
      return;
    }

    let personality: string | undefined;
    try {
      const voiceId = getPersonalityVoiceId(opts.stellaHome);
      personality = readOrSeedPersonality(opts.stellaHome, voiceId) ?? undefined;
    } catch {
      // Treat as no personality available; fall through to marker stripping.
    }

    const trimmed = personality?.trim();

    if (payload.systemPrompt.includes(PERSONALITY_MARKER)) {
      return {
        systemPromptReplace: payload.systemPrompt.replace(
          PERSONALITY_MARKER,
          trimmed ?? "",
        ),
      };
    }

    if (!trimmed) {
      return;
    }

    return {
      systemPromptReplace: `${trimmed}\n\n${payload.systemPrompt}`,
    };
  },
});
