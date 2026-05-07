/**
 * Personality injection hook (bundled).
 *
 * Reads the user's selected personality voice from local preferences and
 * either replaces a `<!-- personality -->` marker in the system prompt or
 * prepends the personality block, then returns the new prompt as
 * `systemPromptReplace`.
 *
 * Gated by the `injectsPersonality` agent capability rather than a literal
 * `agentType === "orchestrator"` check, so future agents that opt into the
 * capability inherit the behavior with no engine edits. Today only the
 * orchestrator declares the flag (see `BUILTIN_AGENT_DEFINITIONS`).
 *
 * Replaces the inline `maybeInjectPersonality` helper that previously lived
 * in `run-preparation.ts`. User-extension `before_agent_start` hooks
 * registered after this one see the personality-augmented prompt because
 * `buildRuntimeSystemPrompt` consumes hook results via `emitAll` and folds
 * them in registration order: each `systemPromptReplace` resets the
 * working prompt and each `systemPromptAppend` appends to it. The
 * canonical extension UX is "extend the personality-augmented baseline,
 * don't fight it."
 */

import { agentHasCapability } from "../../../../contracts/agent-runtime.js";
import type { HookDefinition } from "../../../extensions/types.js";
import { readOrSeedPersonality } from "../../../personality/personality.js";
import { getPersonalityVoiceId } from "../../../preferences/local-preferences.js";

const PERSONALITY_MARKER = "<!-- personality -->";

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
      // Treat as no personality available; fall through to the marker
      // stripping path below if needed.
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
