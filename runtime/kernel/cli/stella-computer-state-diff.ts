export type StateDiffTarget = {
  appName?: string | null;
  bundleId?: string | null;
  pid?: number | null;
  windowTitle?: string | null;
  windowId?: string | number | null;
  capturedAt?: string | null;
  nodeCount?: number | null;
  lineCount: number;
};

export type StateDiffStatus =
  | "baseline"
  | "different-target"
  | "unchanged"
  | "changed";

export type StateDiff = {
  status: StateDiffStatus;
  sameTarget: boolean;
  previous?: StateDiffTarget | null;
  current: StateDiffTarget;
  addedLineCount: number;
  removedLineCount: number;
  changedLineCount: number;
  addedLines: string[];
  removedLines: string[];
  maxLines: number;
  truncated: boolean;
};

const DEFAULT_MAX_DIFF_LINES = 80;

const normalizeTargetText = (value?: string | number | null) =>
  value == null ? "" : String(value).trim().toLowerCase();

export const stateDiffMaxLines = () => {
  const raw = process.env.STELLA_COMPUTER_MAX_DIFF_LINES;
  if (!raw) return DEFAULT_MAX_DIFF_LINES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_DIFF_LINES;
  return Math.floor(parsed);
};

const sameTarget = (previous: StateDiffTarget, current: StateDiffTarget) => {
  const previousWindow = normalizeTargetText(previous.windowId);
  const currentWindow = normalizeTargetText(current.windowId);
  if (previousWindow && currentWindow && previousWindow !== currentWindow) {
    return false;
  }

  const previousBundle = normalizeTargetText(previous.bundleId);
  const currentBundle = normalizeTargetText(current.bundleId);
  if (previousBundle || currentBundle) {
    return previousBundle === currentBundle;
  }

  const previousApp = normalizeTargetText(previous.appName);
  const currentApp = normalizeTargetText(current.appName);
  if (previousApp || currentApp) {
    return previousApp === currentApp;
  }

  return previous.pid != null && previous.pid === current.pid;
};

const lineCounts = (lines: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
};

const countedDelta = (
  left: readonly string[],
  right: readonly string[],
) => {
  const rightCounts = lineCounts(right);
  const removed: string[] = [];
  for (const line of left) {
    const count = rightCounts.get(line) ?? 0;
    if (count > 0) {
      rightCounts.set(line, count - 1);
    } else {
      removed.push(line);
    }
  }

  const leftCounts = lineCounts(left);
  const added: string[] = [];
  for (const line of right) {
    const count = leftCounts.get(line) ?? 0;
    if (count > 0) {
      leftCounts.set(line, count - 1);
    } else {
      added.push(line);
    }
  }

  return { added, removed };
};

const truncateLines = (lines: readonly string[], maxLines: number) => {
  if (maxLines <= 0) return [];
  return lines.slice(0, maxLines);
};

export const computeStateDiff = (input: {
  previousLines?: readonly string[] | null;
  currentLines: readonly string[];
  previousTarget?: StateDiffTarget | null;
  currentTarget: StateDiffTarget;
  maxLines?: number;
}): StateDiff => {
  const maxLines = input.maxLines ?? stateDiffMaxLines();
  const previous = input.previousTarget ?? null;
  const current = input.currentTarget;
  if (!previous || !input.previousLines) {
    return {
      status: "baseline",
      sameTarget: false,
      previous,
      current,
      addedLineCount: 0,
      removedLineCount: 0,
      changedLineCount: 0,
      addedLines: [],
      removedLines: [],
      maxLines,
      truncated: false,
    };
  }

  const targetMatches = sameTarget(previous, current);
  if (!targetMatches) {
    return {
      status: "different-target",
      sameTarget: false,
      previous,
      current,
      addedLineCount: 0,
      removedLineCount: 0,
      changedLineCount: 0,
      addedLines: [],
      removedLines: [],
      maxLines,
      truncated: false,
    };
  }

  const { added, removed } = countedDelta(input.previousLines, input.currentLines);
  const changedLineCount = added.length + removed.length;
  const addedBudget = Math.ceil(maxLines / 2);
  const removedBudget = Math.floor(maxLines / 2);
  const visibleAdded = truncateLines(added, addedBudget);
  const visibleRemoved = truncateLines(removed, removedBudget);

  return {
    status: changedLineCount === 0 ? "unchanged" : "changed",
    sameTarget: true,
    previous,
    current,
    addedLineCount: added.length,
    removedLineCount: removed.length,
    changedLineCount,
    addedLines: visibleAdded,
    removedLines: visibleRemoved,
    maxLines,
    truncated: visibleAdded.length < added.length || visibleRemoved.length < removed.length,
  };
};

const attr = (name: string, value?: string | number | boolean | null) => {
  if (value == null || value === "") return "";
  return ` ${name}="${String(value).replaceAll("\"", "&quot;")}"`;
};

export const shouldUseDiffOnly = (diff: StateDiff | null | undefined) =>
  !!diff &&
  diff.sameTarget &&
  (diff.status === "unchanged" || (diff.status === "changed" && !diff.truncated));

export const formatStateDiffBlock = (diff: StateDiff) => {
  const lines = [
    `<app_state_diff${attr("status", diff.status)}${attr("same_target", diff.sameTarget)}${attr(
      "previous_captured_at",
      diff.previous?.capturedAt,
    )}${attr("current_captured_at", diff.current.capturedAt)}${attr(
      "previous_nodes",
      diff.previous?.nodeCount,
    )}${attr("current_nodes", diff.current.nodeCount)}${attr(
      "added",
      diff.addedLineCount,
    )}${attr("removed", diff.removedLineCount)}${attr("truncated", diff.truncated)}>`,
  ];

  if (diff.status === "baseline") {
    lines.push("No previous app state was available; full app_state follows.");
  } else if (diff.status === "different-target") {
    lines.push("The target changed since the previous snapshot; full app_state follows.");
  } else if (diff.status === "unchanged") {
    lines.push("No accessibility-tree line changes detected since the previous snapshot.");
  } else {
    if (diff.addedLines.length > 0) {
      lines.push("Added lines:");
      lines.push(...diff.addedLines.map((line) => `+ ${line}`));
    }
    if (diff.removedLines.length > 0) {
      lines.push("Removed lines:");
      lines.push(...diff.removedLines.map((line) => `- ${line}`));
    }
    if (diff.truncated) {
      lines.push(
        `Diff truncated to ${diff.maxLines} lines; run snapshot/get-state for the full refreshed tree.`,
      );
    }
  }

  lines.push("</app_state_diff>");
  return `${lines.join("\n")}\n`;
};
