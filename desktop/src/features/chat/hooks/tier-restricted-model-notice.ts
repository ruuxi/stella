/**
 * Pure decision behind the submit-time "model not available on your plan"
 * notice. It lives outside the hook so the engine gate sits next to the rule
 * it enforces and can be tested without React, Convex, or the IPC bridge.
 */
import {
  isRestrictedAudienceAllowedStellaModelId,
  isRestrictedModelOverrideAudience,
  type ManagedModelAudience,
} from "@/global/billing/audience";

export type NoticeRuntimeEngine = "default" | "claude_code_local" | "codex_cli";

const ORCHESTRATOR_AND_GENERAL = ["orchestrator", "general"] as const;

export type TierRestrictedModelNotice = {
  agent: (typeof ORCHESTRATOR_AND_GENERAL)[number];
  model: string;
  modelLabel: string;
};

const getModelToastLabel = (model: string): string => {
  const withoutStellaPrefix = model.startsWith("stella/")
    ? model.slice("stella/".length)
    : model;
  const lastSlash = withoutStellaPrefix.lastIndexOf("/");
  const displayId =
    lastSlash >= 0
      ? withoutStellaPrefix.slice(lastSlash + 1)
      : withoutStellaPrefix;
  return displayId || "That model";
};

/**
 * Returns the restricted pick to notify about, or `null` when this send
 * shouldn't raise a plan notice.
 *
 * The notice is only ever about the Stella model the user selected for THIS
 * run. When a non-Stella engine is committed (Claude Code / ChatGPT), the turn
 * is served by that engine's own model: `buildEngineRoutingPatch` deliberately
 * parks the previous Stella pick back into `modelOverrides` so switching the
 * engine back restores it, and `getClaudeCodeAgentModelId` reads that entry
 * only to detect Stella Light — it never routes it upstream. Toasting on a
 * parked pick told signed-out Claude Code users their plan had blocked a model
 * they had not selected.
 */
export const resolveTierRestrictedModelNotice = (args: {
  audience: ManagedModelAudience | null | undefined;
  agentRuntimeEngine: NoticeRuntimeEngine | undefined;
  modelOverrides: Record<string, string> | undefined;
}): TierRestrictedModelNotice | null => {
  const audience = args.audience;
  if (!audience || !isRestrictedModelOverrideAudience(audience)) return null;
  if ((args.agentRuntimeEngine ?? "default") !== "default") return null;

  const overrides = args.modelOverrides ?? {};
  for (const agent of ORCHESTRATOR_AND_GENERAL) {
    const override = overrides[agent]?.trim();
    if (!override) continue;
    // Only Stella-provider picks are subject to tier restrictions —
    // BYOK / OAuth providers (Anthropic, OpenAI, OpenRouter, local
    // runtime, …) run on the user's own key and are unaffected by
    // Stella plan limits, so don't toast on them.
    if (!override.startsWith("stella/")) continue;
    // The opaque default sentinel is never a restricted pick, and restricted
    // tiers may still select the Standard / Light modes.
    if (override === "stella/default") continue;
    if (isRestrictedAudienceAllowedStellaModelId(override)) continue;
    // One toast per send is enough — don't stack two if both orchestrator
    // and general have non-default overrides.
    return { agent, model: override, modelLabel: getModelToastLabel(override) };
  }
  return null;
};
