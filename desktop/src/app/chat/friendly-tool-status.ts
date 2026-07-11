import type { TaskToolActivity } from "../../../../runtime/contracts/agent-runtime.js";

type FriendlyToolLabels = {
  active: string;
  done: string;
  failed?: string;
};

const FRIENDLY_TOOL_LABELS: Record<string, FriendlyToolLabels> = {
  exec_command: {
    active: "Running command",
    done: "Ran command",
    failed: "Command failed",
  },
  node_repl: { active: "Running code", done: "Ran code" },
  apply_patch: { active: "Editing files", done: "Edited files" },
  edit: { active: "Editing files", done: "Edited files" },
  write: { active: "Editing files", done: "Edited files" },
  strreplace: { active: "Editing files", done: "Edited files" },
  multi_edit: { active: "Editing files", done: "Edited files" },
  write_stdin: { active: "Sending input", done: "Sent input" },
  read: { active: "Reading files", done: "Read files" },
  web: { active: "Searching the web", done: "Searched the web" },
  web_search: { active: "Searching the web", done: "Searched the web" },
  search: { active: "Searching the web", done: "Searched the web" },
  search_query: { active: "Searching the web", done: "Searched the web" },
  find: { active: "Searching files", done: "Searched files" },
  glob: { active: "Searching files", done: "Searched files" },
  view_image: { active: "Viewing image", done: "Viewed image" },
  imagegen: { active: "Creating image", done: "Created image" },
  computer_use: { active: "Using the computer", done: "Used the computer" },
  browser: { active: "Using the browser", done: "Used the browser" },
};

const normalizedToolName = (toolName: string): string => {
  const namespacedParts = toolName.split("__").filter(Boolean);
  return (namespacedParts.at(-1) ?? toolName).trim().toLowerCase();
};

const humanizeToolName = (toolName: string): string => {
  const leaf = toolName.split("__").filter(Boolean).at(-1) ?? toolName;
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "Working";
  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
};

export const friendlyInlineToolStatus = (
  activity: TaskToolActivity,
): string => {
  const labels = FRIENDLY_TOOL_LABELS[normalizedToolName(activity.toolName)];
  const failed =
    activity.state === "completed" &&
    typeof activity.exitCode === "number" &&
    activity.exitCode !== 0;

  if (labels) {
    if (failed && labels.failed) return labels.failed;
    return activity.state === "started" ? labels.active : labels.done;
  }

  const label = humanizeToolName(activity.toolName);
  return failed ? `${label} failed` : label;
};
