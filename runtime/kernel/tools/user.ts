/**
 * User interaction tools: RequestCredential handlers.
 */

import type { ToolResult } from "./types.js";

export type UserToolsConfig = {
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
};

export const handleRequestCredential = async (
  config: UserToolsConfig,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  if (!config.requestCredential) {
    return { error: "Credential requests are not supported on this device." };
  }
  const provider = String(args.provider ?? "").trim();
  if (!provider) {
    return { error: "provider is required." };
  }
  const label = args.label ? String(args.label) : undefined;
  const description = args.description ? String(args.description) : undefined;
  const placeholder = args.placeholder ? String(args.placeholder) : undefined;

  try {
    const response = await config.requestCredential({
      provider,
      label,
      description,
      placeholder,
    });
    return { result: response };
  } catch (error) {
    return { error: (error as Error).message || "Credential request failed." };
  }
};
