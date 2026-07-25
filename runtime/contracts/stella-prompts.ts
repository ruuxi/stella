export const STELLA_PROMPT_SCHEMA_VERSION = 2 as const;

export const STELLA_PROMPT_IDS = [
  "agents/orchestrator.md",
  "agents/general.md",
  "agents/schedule.md",
  "agents/fashion.md",
  "agents/social_session.md",
  "agents/explore.md",
  "agents/dream.md",
  "agents/install_update.md",
  "prompts/dream-scheduled.md",
  "prompts/chronicle-summarizer.md",
  "prompts/memory-review.md",
  "prompts/thread-compaction.md",
  "prompts/fallback-orchestrator.md",
  "prompts/fallback-subagent.md",
  "prompts/personality-stella.md",
  "prompts/personality-professional.md",
] as const;

/**
 * Prompt ids this app no longer installs but still tolerates in a deployed
 * manifest. A backend that hasn't dropped a retired prompt yet must not have
 * its whole manifest rejected — the entry is accepted for revision integrity
 * and then dropped before reconciliation, which would otherwise look for a
 * bundled `agent-metadata/<id>.md` that no longer exists.
 */
export const STELLA_PROMPT_RETIRED_IDS = ["agents/manager.md"] as const;

export const STELLA_PROMPT_RETIRED_ID_SET = new Set<string>(
  STELLA_PROMPT_RETIRED_IDS,
);
export const STELLA_PROMPT_ID_SET = new Set<string>(STELLA_PROMPT_IDS);
export const STELLA_PROMPT_COUNT = STELLA_PROMPT_IDS.length;
export const STELLA_PROMPT_LEGACY_IDS = STELLA_PROMPT_IDS;
export const STELLA_PROMPT_LEGACY_COUNT = STELLA_PROMPT_LEGACY_IDS.length;
export const STELLA_PROMPT_MAX_CONTENT_BYTES = 256 * 1024;
export const STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES = 1024 * 1024;
export const STELLA_PROMPT_MAX_MANIFEST_BYTES = 1200 * 1024;
export const STELLA_PROMPT_REVISION_PATTERN = /^[0-9a-f]{64}$/;
