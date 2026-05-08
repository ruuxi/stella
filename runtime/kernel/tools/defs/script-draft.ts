/**
 * `ScriptDraft` — schedule-only authoring tool.
 *
 * Single tool that fuses three steps the Schedule subagent would otherwise
 * have to chain via shell + apply_patch + a separate run:
 *
 *  1. Pick a fresh `<uuid>.ts` path under `~/.stella/state/schedule-scripts/`
 *     (the agent never picks the path — the tool owns it).
 *  2. Write the provided `code` to that path.
 *  3. Immediately dry-run it under the exact same `bun run` runtime that the
 *     scheduler tick uses for `payload.kind === 'script'` cron fires.
 *
 * Returns the assigned path plus stdout/stderr/exit so the agent can decide
 * whether to commit the cron via `CronAdd({ kind: 'script', scriptPath })`
 * or iterate by calling `ScriptDraft` again with revised code.
 *
 * Iterated calls leave orphan files until either:
 *   - `CronRemove` deletes a referenced script's file, or
 *   - the scheduler's startup `collectOrphanScripts` pass sweeps the
 *     directory for any `.ts` not referenced by an active cron job.
 *
 * Gated to the Schedule subagent — the orchestrator never sees this tool.
 */

import crypto from "node:crypto";
import path from "node:path";
import { AGENT_IDS } from "../../../contracts/agent-runtime.js";
import { ensurePrivateDir, writePrivateFile } from "../../shared/private-fs.js";
import {
  runScheduleScript,
  scheduleScriptsDir,
  SCRIPT_RUN_TIMEOUT_MS,
} from "../../shared/schedule-scripts.js";
import type { ToolDefinition } from "../types.js";

export type ScriptDraftToolOptions = {
  /** Stella home root (e.g. `~/.stella` or repo root). Required. */
  stellaRoot: string;
};

const formatResult = (params: {
  scriptPath: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}): string => {
  const lines = [
    `scriptPath: ${params.scriptPath}`,
    `exitCode: ${params.exitCode}`,
    `durationMs: ${params.durationMs}`,
  ];
  if (params.timedOut) {
    lines.push(`timedOut: true (${SCRIPT_RUN_TIMEOUT_MS}ms cap)`);
  }
  lines.push("");
  lines.push("stdout:");
  lines.push(params.stdout.length > 0 ? params.stdout : "(empty)");
  lines.push("");
  lines.push("stderr:");
  lines.push(params.stderr.length > 0 ? params.stderr : "(empty)");
  return lines.join("\n");
};

export const createScriptDraftTool = (
  options: ScriptDraftToolOptions,
): ToolDefinition => ({
  name: "ScriptDraft",
  agentTypes: [AGENT_IDS.SCHEDULE],
  description:
    "Write a Bun/TypeScript script to the schedule-scripts directory and immediately dry-run it. Returns the assigned scriptPath plus exitCode, stdout, and stderr. Use stdout to deliver the message at fire time (empty stdout = silent). When the dry-run looks correct, register the cron with `CronAdd({ kind: 'script', scriptPath })`.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "Full TypeScript source for the script. Print to stdout to deliver an assistant message + OS notification at fire time; print nothing to stay silent. May read/write a sidecar `<scriptPath>.state.json` for cross-run state. Wall-clock cap: 30s per run.",
      },
    },
    required: ["code"],
  },
  execute: async (args) => {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) {
      return { error: "code is required." };
    }

    const dir = scheduleScriptsDir(options.stellaRoot);
    await ensurePrivateDir(dir);
    const scriptPath = path.join(dir, `${crypto.randomUUID()}.ts`);
    await writePrivateFile(scriptPath, code);

    const runResult = await runScheduleScript(scriptPath);
    return {
      result: formatResult({
        scriptPath,
        exitCode: runResult.exitCode,
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        durationMs: runResult.durationMs,
        timedOut: runResult.timedOut,
      }),
    };
  },
});
