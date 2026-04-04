/**
 * Curated Google Workspace tool names in canonical dot form. The vendored
 * upstream Workspace integration can expose these with either dots or
 * underscores depending on startup flags, so Stella normalizes before matching.
 *
 * @see https://github.com/gemini-cli-extensions/workspace/blob/main/docs/index.md
 */
export const GOOGLE_WORKSPACE_TOOL_ALLOWLIST = [
  // Auth / session (upstream OAuth; not Stella secrets)
  "auth.clear",
  "auth.refreshToken",
  // Docs
  "docs.create",
  "docs.getSuggestions",
  "docs.getComments",
  "docs.writeText",
  "docs.getText",
  "docs.replaceText",
  "docs.formatText",
  // Drive (no trash in v1)
  "drive.search",
  "drive.findFolder",
  "drive.createFolder",
  "drive.downloadFile",
  "drive.renameFile",
  // Calendar (no delete in v1)
  "calendar.list",
  "calendar.createEvent",
  "calendar.listEvents",
  "calendar.getEvent",
  "calendar.findFreeTime",
  "calendar.updateEvent",
  "calendar.respondToEvent",
  // Gmail (no batch destructive ops in v1)
  "gmail.search",
  "gmail.get",
  "gmail.downloadAttachment",
  "gmail.modify",
  "gmail.send",
  "gmail.createDraft",
  "gmail.sendDraft",
  "gmail.listLabels",
  "gmail.createLabel",
  // Time helpers
  "time.getCurrentDate",
  "time.getCurrentTime",
  "time.getTimeZone",
  // People
  "people.getMe",
] as const;

export type GoogleWorkspaceToolName =
  (typeof GOOGLE_WORKSPACE_TOOL_ALLOWLIST)[number];

export const canonicalizeGoogleWorkspaceToolName = (name: string): string =>
  name.replace(/_/g, ".");

export const toGoogleWorkspaceToolRegistrationName = (
  name: string,
): string => canonicalizeGoogleWorkspaceToolName(name).replace(/\./g, "_");

export const getGoogleWorkspaceToolAliases = (name: string): string[] => {
  const canonicalName = canonicalizeGoogleWorkspaceToolName(name);
  return Array.from(
    new Set([
      canonicalName,
      toGoogleWorkspaceToolRegistrationName(canonicalName),
    ]),
  );
};

const ALLOWLIST_SET = new Set<string>(
  GOOGLE_WORKSPACE_TOOL_ALLOWLIST.map(canonicalizeGoogleWorkspaceToolName),
);

export const isAllowedGoogleWorkspaceTool = (name: string): boolean =>
  ALLOWLIST_SET.has(canonicalizeGoogleWorkspaceToolName(name));
