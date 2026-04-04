import type { ToolResult } from "../tools/types.js";

const stringifyGoogleWorkspaceError = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error.trim();
    }
  }

  if (value == null) {
    return null;
  }

  try {
    const text = JSON.stringify(value);
    return text && text !== "{}" ? text : null;
  } catch {
    return String(value);
  }
};

const getGoogleWorkspaceJsonError = (text: string): string | null => {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return stringifyGoogleWorkspaceError(
      (parsed as Record<string, unknown>).error,
    );
  } catch {
    return null;
  }
};

/** Converts upstream Google Workspace tool output into Stella `ToolResult`. */
export const formatGoogleWorkspaceCallToolResult = (
  result: unknown,
): ToolResult => {
  const r = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const parts =
    r.content?.map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return JSON.stringify(block);
    }) ?? [];

  const text = parts.join("\n").trim();
  const jsonError = getGoogleWorkspaceJsonError(text);

  if (r.isError || jsonError) {
    return {
      error:
        (jsonError ?? text) || "Google Workspace tool returned an error.",
    };
  }
  return { result: text || "(empty result)" };
};
