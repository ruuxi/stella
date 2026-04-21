/**
 * Single `tools.shell` entry for the Exec registry.
 *
 * Three operations dispatched by `op`:
 *
 *   - `op: "run"` (default): execute a command. Defaults to foreground; pass
 *     `background: true` to start it without waiting and get back a `shell_id`.
 *   - `op: "status"`: inspect a previously backgrounded shell (or list all).
 *   - `op: "kill"`: terminate a backgrounded shell.
 *
 * `tools.shell` exists primarily to wire Stella's own CLIs (`stella-browser`,
 * `stella-office`, `stella-ui`, `stella-computer`) into the shell PATH and
 * preserve background processes across Exec cells. For commands that don't
 * need either of those, plain `require("node:child_process")` inside the
 * Exec program works equally well.
 */

import {
  extractOfficePreviewRef,
  runShell,
  startShell,
  type ShellState,
} from "../../shell.js";
import { isDangerousCommand } from "../../command-safety.js";
import { getStellaBrowserBridgeEnv } from "../../stella-browser-bridge-config.js";
import { getStellaComputerSessionId } from "../../stella-computer-session.js";
import { truncate } from "../../utils.js";
import type { ExecToolDefinition } from "../registry.js";

const SHELL_SCHEMA = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["run", "status", "kill"],
      description:
        "Operation. Defaults to 'run'. Use 'status' / 'kill' on a previously backgrounded shell.",
    },
    command: {
      type: "string",
      description:
        "Shell command to execute (required for op='run'). Stella CLIs (stella-browser, stella-office, stella-computer) are auto-injected into PATH.",
    },
    description: {
      type: "string",
      description: "Optional human-readable description of the command.",
    },
    cwd: {
      type: "string",
      description: "Working directory (absolute). Defaults to process.cwd().",
    },
    timeout_ms: {
      type: "number",
      description:
        "Timeout in milliseconds for foreground op='run' (default 120000, max 600000).",
    },
    background: {
      type: "boolean",
      description:
        "When true, op='run' starts the command in the background and returns a `shell_id` immediately so it can survive across Exec cells. Inspect later with op='status', stop with op='kill'.",
    },
    shell_id: {
      type: "string",
      description:
        "Required for op='status' / op='kill'. The id returned by an earlier op='run' with background: true. For op='status', omit to list all known shells.",
    },
    tail_lines: {
      type: "number",
      description:
        "For op='status' on a single shell, how many trailing lines of output to return (default 50).",
    },
  },
} as const;

const shouldUseStellaBrowserBridge = (command: string): boolean =>
  /\bstella-browser\b/.test(command) || /\bSTELLA_BROWSER_SESSION=/.test(command);

const shouldUseStellaComputer = (command: string): boolean =>
  /\bstella-computer\b/.test(command);

const normalizeComputerAgentShellCommand = (command: string) =>
  command
    .replace(
      /(?:^|&&\s*|\|\|\s*|;\s*)STELLA_BROWSER_SESSION=[^\s]+(?=\s+stella-browser\b)/g,
      (match) => match.replace(/STELLA_BROWSER_SESSION=[^\s]+\s*/, ""),
    )
    .replace(/\bstella-browser\s+--session(?:=|\s+)\S+\s*/g, "stella-browser ")
    .replace(/\s{2,}/g, " ")
    .trim();

type ShellOp = "run" | "status" | "kill";

const resolveOp = (raw: unknown): ShellOp => {
  if (raw === "status" || raw === "kill") return raw;
  return "run";
};

export const createShellBuiltins = (
  shellState: ShellState,
): ExecToolDefinition[] => [
  {
    name: "shell",
    description:
      "Run shell commands and manage backgrounded shells.\n\n" +
      "When to use:\n" +
      "- Always for Stella CLIs (stella-browser, stella-office, stella-computer) — `tools.shell` injects them into PATH and wires per-task session ids/env.\n" +
      "- For long-running processes that should survive across Exec cells (e.g. dev servers): pass `background: true`, capture the returned `shell_id`, and check on it later via `op: 'status'` / `op: 'kill'`.\n" +
      "- For a one-shot command without Stella-CLI wiring or background needs, you can also just use `require(\"node:child_process\")` inside the Exec program — `tools.shell` is not required.\n\n" +
      "Operations:\n" +
      "- `op: 'run'` (default): foreground unless `background: true`. Returns `{ output, background, shell_id? }`.\n" +
      "- `op: 'status'`: with `shell_id`, returns one record. Without, lists every shell.\n" +
      "- `op: 'kill'`: with `shell_id`, terminates that shell and returns its accumulated output.",
    inputSchema: SHELL_SCHEMA,
    handler: async (rawArgs, context) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const op = resolveOp(args.op);

      if (op === "status") {
        const shellId = args.shell_id ? String(args.shell_id) : "";
        if (!shellId) {
          return {
            shells: Array.from(shellState.shells.entries()).map(([id, r]) => ({
              id,
              command: r.command.slice(0, 100),
              running: r.running,
              exitCode: r.exitCode,
              elapsedSec: r.running
                ? Math.round((Date.now() - r.startedAt) / 1000)
                : Math.round((r.completedAt! - r.startedAt) / 1000),
            })),
          };
        }
        const record = shellState.shells.get(shellId);
        if (!record) throw new Error(`Shell not found: ${shellId}`);
        const tailLines = Number(args.tail_lines ?? 50);
        const lines = (record.output || "").split("\n");
        const tail = truncate(lines.slice(-tailLines).join("\n"));
        return {
          shell_id: record.id,
          running: record.running,
          exitCode: record.exitCode,
          startedAt: record.startedAt,
          completedAt: record.completedAt,
          elapsedSec: Math.round(
            ((record.completedAt ?? Date.now()) - record.startedAt) / 1000,
          ),
          command: record.command.slice(0, 200),
          output: tail,
        };
      }

      if (op === "kill") {
        const shellId = String(args.shell_id ?? "");
        if (!shellId) throw new Error("shell_id is required for op='kill'.");
        const record = shellState.shells.get(shellId);
        if (!record) throw new Error(`Shell not found: ${shellId}`);
        if (!record.running) {
          return {
            shell_id: shellId,
            alreadyExited: true,
            exitCode: record.exitCode,
            output: truncate(record.output),
          };
        }
        record.kill();
        return {
          shell_id: shellId,
          alreadyExited: false,
          output: truncate(record.output),
        };
      }

      let command = String(args.command ?? "");
      if (!command.trim()) throw new Error("command is required for op='run'.");
      const dangerous = isDangerousCommand(command);
      if (dangerous) {
        throw new Error(
          `Command blocked: this operation is potentially destructive and has been denied for safety. (${dangerous})`,
        );
      }
      const cwd = String(args.cwd ?? context.stellaRoot ?? process.cwd());
      const timeoutMs = Math.min(
        Number(args.timeout_ms ?? 120_000),
        600_000,
      );
      const background = Boolean(args.background ?? false);

      const envOverrides: Record<string, string> = {};
      const browserOwnerId =
        context.taskId ?? context.runId ?? context.rootRunId;
      const stellaComputerSessionId = getStellaComputerSessionId(context);

      if (shouldUseStellaBrowserBridge(command)) {
        command = normalizeComputerAgentShellCommand(command);
        Object.assign(envOverrides, getStellaBrowserBridgeEnv());
        if (browserOwnerId) {
          envOverrides.STELLA_BROWSER_OWNER_ID = browserOwnerId;
        }
      }
      if (shouldUseStellaComputer(command) && stellaComputerSessionId) {
        envOverrides.STELLA_COMPUTER_SESSION = stellaComputerSessionId;
      }

      if (background) {
        const record = startShell(shellState, command, cwd, envOverrides);
        const extracted = extractOfficePreviewRef(record.output || "");
        return {
          shell_id: record.id,
          background: true,
          output: truncate(extracted.cleanedOutput || "(no output yet)"),
          ...(extracted.officePreviewRef
            ? { officePreviewRef: extracted.officePreviewRef }
            : {}),
        };
      }

      const output = await runShell(
        shellState,
        command,
        cwd,
        timeoutMs,
        envOverrides,
      );
      const extracted = extractOfficePreviewRef(output);
      return {
        background: false,
        output: truncate(extracted.cleanedOutput),
        ...(extracted.officePreviewRef
          ? { officePreviewRef: extracted.officePreviewRef }
          : {}),
      };
    },
  },
];
