/**
 * Curated Google Workspace MCP tool names in canonical dot form. The vendored
 * upstream server can expose these with either dots or underscores depending on
 * its startup flags, so Stella normalizes before matching.
 *
 * @see https://github.com/gemini-cli-extensions/workspace/blob/main/docs/index.md
 */
export const GOOGLE_WORKSPACE_MCP_TOOL_ALLOWLIST = [
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

export type GoogleWorkspaceMcpToolName =
  (typeof GOOGLE_WORKSPACE_MCP_TOOL_ALLOWLIST)[number];

export const canonicalizeGoogleWorkspaceMcpToolName = (name: string): string =>
  name.replace(/_/g, ".");

export const getGoogleWorkspaceMcpToolAliases = (name: string): string[] => {
  const canonicalName = canonicalizeGoogleWorkspaceMcpToolName(name);
  return Array.from(
    new Set([canonicalName, canonicalName.replace(/\./g, "_")]),
  );
};

const ALLOWLIST_SET = new Set<string>(
  GOOGLE_WORKSPACE_MCP_TOOL_ALLOWLIST.map(canonicalizeGoogleWorkspaceMcpToolName),
);

export const isAllowedGoogleWorkspaceMcpTool = (name: string): boolean =>
  ALLOWLIST_SET.has(canonicalizeGoogleWorkspaceMcpToolName(name));
