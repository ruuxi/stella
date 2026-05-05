/**
 * `exec_command` tool — Codex-style PTY shell execution.
 *
 * Mirrors the surface from
 * https://github.com/openai/codex/blob/main/codex-rs/tools/src/local_tool.rs
 * so models that already know Codex's contract transfer 1:1.
 *
 * Returns immediate output, or a `session_id` when the process is still
 * running so the model can poll / interact via `write_stdin`.
 */

import { handleExecCommand, type ShellState } from "../shell.js";
import type { ToolDefinition } from "../types.js";

export const createExecCommandTool = (
  shellState: ShellState,
): ToolDefinition => ({
  name: "exec_command",
  description:
    "Run a shell command in a PTY. Returns immediate output, or a session_id if the process is still running so you can poll/interact via write_stdin. Required: cmd. Stella CLIs (stella-browser, stella-office, stella-computer) are auto-injected into PATH.",
  promptSnippet: "Execute shell commands (git, build, package managers, file scripts)",
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
        description: "Maximum number of tokens to return. Excess output is truncated.",
      },
      login: {
        type: "boolean",
        description:
          "Whether to run the shell with -l/-i semantics. Defaults to true.",
      },
    },
    required: ["cmd"],
  },
  execute: (args, context, extras) =>
    handleExecCommand(shellState, args, context, extras?.signal),
});
