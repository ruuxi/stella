/**
 * `exec_command` tool — PTY shell execution for Stella agents.
 *
 * Returns immediate output, or a `session_id` when the process is still
 * running so the model can poll / interact via `write_stdin`.
 */

import {
  maybeOfferBrowserExtensionConnect,
  type BrowserExtensionConnectRequester,
} from "../browser-extension-offer.js";
import { handleExecCommand, type ShellState } from "../shell.js";
import type { ToolDefinition } from "../types.js";

export type ExecCommandToolOptions = {
  /**
   * Desktop hop that renders the inline "connect the Stella browser
   * extension" card in the chat and resolves when the user connects,
   * declines, or the card times out. When omitted, extension-bridge
   * failures surface as plain command output.
   */
  requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
};

export const createExecCommandTool = (
  shellState: ShellState,
  options: ExecCommandToolOptions = {},
): ToolDefinition => ({
  name: "exec_command",
  description:
    "Run a shell command in a PTY. Returns immediate output, or a session_id if the process is still running so you can poll/interact via write_stdin. Required: cmd. Stella CLIs (stella-browser, stella-office, stella-computer, stella-connect, stella-media, stella-x-api) are auto-injected into PATH.",
  promptSnippet:
    "Execute shell commands (git, build, package managers, file scripts)",
  parameters: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "Shell command to execute." },
      workdir: {
        type: "string",
        description:
          "Optional working directory to run the command in; defaults to the turn cwd.",
      },
      shell: {
        type: "string",
        description:
          "Shell binary to launch. Defaults to Stella's platform shell.",
      },
      tty: {
        type: "boolean",
        description:
          "Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY.",
      },
      yield_time_ms: {
        type: "number",
        description:
          "How long to wait (in milliseconds) for output before yielding control back to you with a session_id. Defaults to 10000.",
      },
      max_output_tokens: {
        type: "number",
        description:
          "Maximum number of tokens to return. Excess output is truncated.",
      },
      login: {
        type: "boolean",
        description:
          "Whether to run the shell with -l/-i semantics. Defaults to true.",
      },
    },
    required: ["cmd"],
  },
  execute: async (args, context, extras) => {
    const run = () =>
      handleExecCommand(
        shellState,
        args,
        context,
        extras?.signal,
        extras?.onUpdate,
      );
    const result = await run();
    const command = typeof args.cmd === "string" ? args.cmd : "";
    if (!command || !options.requestBrowserExtensionConnect) return result;
    // stella-browser dead-ends on a missing Chrome extension. Offer the
    // inline connect card and, once the user connects, re-run the exact
    // command so the agent continues transparently.
    return await maybeOfferBrowserExtensionConnect({
      result,
      command,
      requestConnect: options.requestBrowserExtensionConnect,
      rerun: run,
      ...(context?.conversationId
        ? { conversationId: context.conversationId }
        : {}),
      ...(context?.agentId ? { agentId: context.agentId } : {}),
      signal: extras?.signal,
    });
  },
});
