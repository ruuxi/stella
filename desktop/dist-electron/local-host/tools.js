/**
 * Tool host factory and registry.
 *
 * This module creates the tool execution environment and composes all tool handlers.
 * Individual tool implementations are split into domain-specific files:
 *
 * - tools-types.ts    — Shared type definitions
 * - tools-utils.ts    — Shared utilities (logging, path expansion, truncation, etc.)
 * - tools-file.ts     — Read, Write, Edit handlers
 * - tools-search.ts   — Glob, Grep handlers
 * - tools-shell.ts    — Bash, SkillBash handlers
 * - tools-web.ts      — WebFetch, WebSearch handlers
 * - tools-state.ts    — Task, TaskOutput handlers
 * - tools-user.ts     — AskUserQuestion, RequestCredential handlers
 */
import path from "path";
// Utilities
import { log, logError } from "./tools-utils.js";
// Tool handlers
import { handleRead, handleWrite, handleEdit, setFileToolsConfig } from "./tools-file.js";
import { handleGlob, handleGrep } from "./tools-search.js";
import { createShellState, handleBash, handleKillShell, handleOpenApp, handleSkillBash, } from "./tools-shell.js";
// WebFetch and WebSearch have been promoted to backend tools (Convex actions).
// import { handleWebFetch, handleWebSearch } from "./tools-web.js";
import { createStateContext, handleTask, handleTaskOutput, } from "./tools-state.js";
import { handleAskUser, handleRequestCredential } from "./tools-user.js";
import { handleSelfModStart, handleSelfModApply, handleSelfModRevert, handleSelfModStatus, handleSelfModPackage, } from "./tools_self_mod.js";
import { handleManagePackage, } from "./tools_store.js";
export const createToolHost = ({ StellaHome, frontendRoot, requestCredential, resolveSecret }) => {
    const stateRoot = path.join(StellaHome, "state");
    // Configure file tools with frontend root for self-mod interception
    setFileToolsConfig({ frontendRoot });
    // User tools config
    const userConfig = { requestCredential };
    // Secret resolution helper for shell tools
    const resolveSecretValue = async (spec, cache, context, toolName) => {
        if (cache.has(spec.provider)) {
            return cache.get(spec.provider) ?? null;
        }
        if (!resolveSecret)
            return null;
        let resolved = await resolveSecret({
            provider: spec.provider,
            requestId: context?.requestId,
            toolName,
            deviceId: context?.deviceId,
        });
        if (!resolved && requestCredential) {
            const response = await requestCredential({
                provider: spec.provider,
                label: spec.label ?? spec.provider,
                description: spec.description,
                placeholder: spec.placeholder,
            });
            resolved = await resolveSecret({
                provider: spec.provider,
                secretId: response.secretId,
                requestId: context?.requestId,
                toolName,
                deviceId: context?.deviceId,
            });
        }
        if (!resolved)
            return null;
        cache.set(spec.provider, resolved.plaintext);
        return resolved.plaintext;
    };
    // Initialize shell and state contexts
    const shellState = createShellState(resolveSecretValue);
    const stateContext = createStateContext(stateRoot);
    const setSkills = (skills) => {
        shellState.skillCache = skills;
    };
    const notConfigured = (name) => ({
        result: `${name} is not configured on this device yet.`,
    });
    // Handler registry
    const handlers = {
        // File tools (context passed for self-mod interception)
        Read: (args, context) => handleRead(args, context),
        Write: (args, context) => handleWrite(args, context),
        Edit: (args, context) => handleEdit(args, context),
        // Search tools
        Glob: (args) => handleGlob(args),
        Grep: (args) => handleGrep(args),
        // Shell tools
        OpenApp: (args) => handleOpenApp(args),
        Bash: (args, context) => handleBash(shellState, args, context),
        KillShell: (args) => handleKillShell(shellState, args),
        SkillBash: (args, context) => handleSkillBash(shellState, args, context),
        // State tools
        Task: (args) => handleTask(stateContext, args),
        TaskOutput: (args) => handleTaskOutput(stateContext, args),
        // User tools
        AskUserQuestion: (args) => handleAskUser(args),
        RequestCredential: (args) => handleRequestCredential(userConfig, args),
        // Media tools (not yet implemented)
        MediaGenerate: async () => notConfigured("MediaGenerate"),
        // Self-mod tools
        SelfModStart: (args, context) => handleSelfModStart(args, context),
        SelfModApply: (args, context) => handleSelfModApply(args, context, frontendRoot),
        SelfModRevert: (args, context) => handleSelfModRevert(args, context, frontendRoot),
        SelfModStatus: (args, context) => handleSelfModStatus(args, context),
        SelfModPackage: (args, context) => handleSelfModPackage(args, context, frontendRoot),
        // Store tools
        ManagePackage: (args) => handleManagePackage(args),
    };
    const executeTool = async (toolName, toolArgs, context) => {
        log(`Executing tool: ${toolName}`, {
            args: toolName.includes("hera-browser")
                ? { code: toolArgs.code?.slice(0, 200) + "...", timeout: toolArgs.timeout }
                : toolArgs,
            context,
        });
        const handler = handlers[toolName];
        if (!handler) {
            const availableTools = Object.keys(handlers);
            logError(`Unknown tool: ${toolName}. Available tools:`, availableTools);
            return { error: `Unknown tool: ${toolName}` };
        }
        const startTime = Date.now();
        try {
            const result = await handler(toolArgs, context);
            const duration = Date.now() - startTime;
            log(`Tool ${toolName} completed in ${duration}ms`, {
                hasResult: "result" in result,
                hasError: "error" in result,
                resultPreview: result.error
                    ? result.error.slice(0, 500)
                    : typeof result.result === "string"
                        ? result.result.slice(0, 500)
                        : "(non-string result)",
            });
            return result;
        }
        catch (error) {
            const duration = Date.now() - startTime;
            logError(`Tool ${toolName} threw after ${duration}ms:`, error);
            return { error: `Tool ${toolName} failed: ${error.message}` };
        }
    };
    const killAllShells = () => {
        for (const shell of shellState.shells.values()) {
            if (shell.running) {
                shell.kill();
            }
        }
    };
    const killShellsByPort = (port) => {
        const portStr = String(port);
        for (const shell of shellState.shells.values()) {
            if (shell.running && shell.command.includes(portStr)) {
                shell.kill();
            }
        }
    };
    return {
        executeTool,
        getShells: () => Array.from(shellState.shells.values()),
        killAllShells,
        killShellsByPort,
        setSkills,
    };
};
