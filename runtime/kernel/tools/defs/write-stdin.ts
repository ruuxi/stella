/**
 * `write_stdin` tool — continue/poll an `exec_command` PTY session.
 *
 * Pass empty `chars` to poll for more output without sending input.
 * Required: `session_id` returned by a still-running `exec_command`.
 */

import {
  maybeOfferBrowserExtensionConnect,
  type BrowserExtensionConnectRequester,
} from "../browser-extension-offer.js";
import {
  handleExecCommand,
  handleWriteStdin,
  type ShellState,
} from "../shell.js";
import type { ToolDefinition } from "../types.js";

export type WriteStdinToolOptions = {
  /** See `ExecCommandToolOptions.requestBrowserExtensionConnect`. */
  requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
};

export const createWriteStdinTool = (
  shellState: ShellState,
  options: WriteStdinToolOptions = {},
): ToolDefinition => ({
  name: "write_stdin",
  description:
    "Continue an existing exec_command session: write characters to its stdin and read recent output. Pass empty chars to poll without sending input. Required: session_id.",
  promptSnippet: "Continue or poll a long-running exec_command session",
  parameters: {
    type: "object",
    properties: {
      session_id: {
        // Stella allocates UUID session ids; advertised as `string` so strict
        // tool validators don't reject the value the model echoes back.
        type: "string",
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
          "How long to wait (in milliseconds) for output before yielding. Defaults to 250.",
      },
      max_output_tokens: {
        type: "number",
        description: "Maximum number of tokens to return. Excess output is truncated.",
      },
    },
    required: ["session_id"],
  },
  execute: async (args, context, extras) => {
    const result = await handleWriteStdin(
      shellState,
      args,
      context,
      extras?.signal,
    );
    if (!options.requestBrowserExtensionConnect) return result;
    // A cold-start stella-browser failure usually outlives exec_command's
    // default yield (the daemon waits up to 60s for the extension), so the
    // "Extension not connected" error typically surfaces on a poll here
    // rather than on the original exec_command call. Same offer + re-run
    // flow, reconstructing the command from the completed session record.
    const payload = result.result;
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const command = typeof record?.command === "string" ? record.command : "";
    if (!command) return result;
    return await maybeOfferBrowserExtensionConnect({
      result,
      command,
      requestConnect: options.requestBrowserExtensionConnect,
      rerun: () =>
        handleExecCommand(
          shellState,
          {
            cmd: command,
            ...(typeof record?.cwd === "string"
              ? { workdir: record.cwd }
              : {}),
          },
          context,
          extras?.signal,
          extras?.onUpdate,
        ),
      ...(context?.conversationId
        ? { conversationId: context.conversationId }
        : {}),
      ...(context?.agentId ? { agentId: context.agentId } : {}),
      signal: extras?.signal,
    });
  },
});
