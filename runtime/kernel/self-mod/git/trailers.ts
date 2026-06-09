const TRAILER_LINE_REGEX = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/;

const STELLA_INTERNAL_TRAILERS = new Set([
  "Stella-Conversation",
  "Stella-Thread",
  "Stella-Package-Id",
  "Stella-Release-Number",
  "Stella-Task",
  "Stella-Feature-Id",
  "Stella-Feature-Title",
  "Stella-Parent-Package-Id",
]);

/**
 * Allowlist for values recorded as `Stella-Conversation` / `Stella-Thread`
 * trailers. Callers that build thread keys MUST produce values matching
 * this shape — a value that fails validation is dropped from the commit
 * and revert-notice routing silently degrades to orchestrator-only.
 * Validate at the boundary where the key is built (`isValidStellaTrailerValue`)
 * so a new key shape fails loudly instead.
 */
export const STELLA_TRAILER_VALUE_REGEX = /^[A-Za-z0-9._:\-]{1,200}$/;

export const isValidStellaTrailerValue = (value: string): boolean =>
  STELLA_TRAILER_VALUE_REGEX.test(value);

export const sanitizeStellaTrailerValue = (
  value: string | undefined,
): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return isValidStellaTrailerValue(trimmed) ? trimmed : undefined;
};

export type StellaCommitTrailers = {
  conversationId?: string;
  /**
   * Engine thread key of the agent that authored this commit.
   * For orchestrator-authored commits this equals `conversationId`;
   * for subagent-authored commits this is the subagent's persisted
   * `agentId`/`threadId`. Used by the revert-notice hook to route
   * the "user undid your change" reminder back to the same thread
   * when the orchestrator later resumes it via `send_input`.
   * Optional — commits authored before this trailer existed have
   * no thread-level routing and fall back to conversation-only.
   */
  threadKey?: string;
  packageId?: string;
  featureId?: string;
  featureTitle?: string;
  /**
   * Multi-parent: a single feature group may legitimately extend more
   * than one installed add-on (e.g. a theme that touches two mods).
   * `Stella-Parent-Package-Id` is therefore allowed to repeat in a
   * single commit body. Order is preserved as written.
   */
  parentPackageIds: string[];
};

export const parseStellaCommitTrailers = (
  body: string,
): StellaCommitTrailers => {
  const trailers: StellaCommitTrailers = { parentPackageIds: [] };
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(TRAILER_LINE_REGEX);
    if (!match) continue;
    const [, key, value] = match;
    const trimmedValue = value?.trim();
    if (!trimmedValue) continue;
    if (key === "Stella-Conversation") {
      trailers.conversationId = trimmedValue;
    } else if (key === "Stella-Thread") {
      trailers.threadKey = trimmedValue;
    } else if (key === "Stella-Package-Id") {
      trailers.packageId = trimmedValue;
    } else if (key === "Stella-Feature-Id") {
      trailers.featureId = trimmedValue;
    } else if (key === "Stella-Feature-Title") {
      trailers.featureTitle = trimmedValue;
    } else if (key === "Stella-Parent-Package-Id") {
      trailers.parentPackageIds.push(trimmedValue);
    }
  }
  return trailers;
};

// Legacy commits from the pre-Phase-3 feature/batch scheme used a
// `[feature:<id>, +N]` subject prefix. We strip it so the normalized
// list shows clean human-readable subjects without rewriting history.
const LEGACY_FEATURE_TAG_REGEX = /\[feature:[a-zA-Z0-9_-]+(?:,\s*\+\d+)?\]/g;

export const stripLegacyFeatureTagFromSubject = (subject: string): string => {
  LEGACY_FEATURE_TAG_REGEX.lastIndex = 0;
  return subject.replace(LEGACY_FEATURE_TAG_REGEX, "").trim();
};

export const hasLegacyFeatureTag = (message: string): boolean => {
  LEGACY_FEATURE_TAG_REGEX.lastIndex = 0;
  const tagged = LEGACY_FEATURE_TAG_REGEX.test(message);
  LEGACY_FEATURE_TAG_REGEX.lastIndex = 0;
  return tagged;
};

export const stripStellaTrailerLinesFromBody = (body: string): string => {
  const lines = body.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const match = line.match(TRAILER_LINE_REGEX);
    if (!match) return true;
    return !STELLA_INTERNAL_TRAILERS.has(match[1] ?? "");
  });
  return filtered.join("\n").trim();
};

// Single ERE pattern used both server-side (`git log --grep`) and as an
// in-memory safety net. Matches any Stella-internal trailer key or the
// legacy `[feature:…]` tag, so non-Stella commits never reach the Store
// UI or publish path.
export const STELLA_COMMIT_GREP_PATTERN =
  "Stella-(Conversation|Package-Id|Release-Number|Task|Feature-Id|Feature-Title|Parent-Package-Id)|\\[feature:";
const STELLA_COMMIT_VERIFY_REGEX = new RegExp(STELLA_COMMIT_GREP_PATTERN);
const STELLA_STORE_APPLY_TRAILER_REGEX =
  /^Stella-(Package-Id|Release-Number|Task):/m;

export const isStellaSelfModCommitMessage = (rawMessage: string): boolean =>
  STELLA_COMMIT_VERIFY_REGEX.test(rawMessage);

export const isPublishableStellaSelfModCommitMessage = (
  rawMessage: string,
): boolean =>
  isStellaSelfModCommitMessage(rawMessage) &&
  !STELLA_STORE_APPLY_TRAILER_REGEX.test(rawMessage);
