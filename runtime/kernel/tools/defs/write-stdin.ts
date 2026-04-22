/**
 * `write_stdin` tool — continue/poll an `exec_command` PTY session.
 *
 * Pass empty `chars` to poll for more output without sending input.
 * Required: `session_id` returned by a still-running `exec_command`.
 */

import { handleWriteStdin, type ShellState } from "../shell.js";
import type { ToolDefinition } from "../types.js";

export const createWriteStdinTool = (
  shellState: ShellState,
): ToolDefinition => ({
  name: "write_stdin",
  description:
    "Continue an existing exec_command session: write characters to its stdin and read recent output. Pass empty chars to poll without sending input. Required: session_id.",
  promptSnippet: "Continue or poll a long-running exec_command session",
  parameters: {
    type: "object",
    properties: {
      session_id: {
        type: "number",
        description: "Identifier of a still-running exec_command session.",
      },
      chars: {
        type: "string",
        description:
          "Bytes to write to stdin. May be empty to poll for more output without sending input.",
      },
      yield_time_ms: {
        type: "number",
        description:
          "How long to wait (in milliseconds) for output before yielding.",
      },
      max_output_tokens: {
        type: "number",
        description: "Maximum number of tokens to return. Excess output is truncated.",
      },
    },
    required: ["session_id"],
  },
  execute: (args, context, extras) =>
    handleWriteStdin(shellState, args, context, extras?.signal),
});
