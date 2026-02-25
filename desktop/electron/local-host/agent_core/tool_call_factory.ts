import {
  generateDeterministicToolCallId,
  hashToolArgs,
} from "./tool_call_ids.js";

export type ToolCallIdFactoryArgs = {
  runId: string;
  getTurnIndex: () => number;
  toolCallCounters: Map<string, number>;
};

export function createToolCallIdFactory(
  args: ToolCallIdFactoryArgs,
): (toolName: string, toolArgs: Record<string, unknown>) => string {
  return (toolName: string, toolArgs: Record<string, unknown>) => {
    const turnIndex = args.getTurnIndex();
    const key = `${turnIndex}:${toolName}:${hashToolArgs(toolArgs)}`;
    const ordinal = args.toolCallCounters.get(key) ?? 0;
    args.toolCallCounters.set(key, ordinal + 1);
    return generateDeterministicToolCallId(
      args.runId,
      turnIndex,
      toolName,
      toolArgs,
      ordinal,
    );
  };
}
