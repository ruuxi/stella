/**
 * Tool host factory and registry.
 *
 * This module creates the tool execution environment and composes all tool handlers.
 * Individual tool implementations are split into domain-specific files:
 *
 * - tools-types.ts    — Shared type definitions
 * - tools-utils.ts    — Shared utilities (logging, path expansion, truncation, etc.)
 * - tools-database.ts — SqliteQuery handler
 * - tools-file.ts     — Read, Write, Edit handlers
 * - tools-search.ts   — Glob, Grep handlers
 * - tools-shell.ts    — Bash, SkillBash, KillShell handlers
 * - tools-web.ts      — WebFetch, WebSearch handlers
 * - tools-state.ts    — TodoWrite, TestWrite, Task, TaskOutput handlers
 * - tools-user.ts     — AskUserQuestion, RequestCredential handlers
 */
import path from "path";
import { loadPluginsFromHome } from "./plugins.js";
// Utilities
import { log, logError } from "./tools-utils.js";
// Tool handlers
import { handleSqliteQuery } from "./tools-database.js";
import { handleRead, handleWrite, handleEdit } from "./tools-file.js";
import { handleGlob, handleGrep } from "./tools-search.js";
import { createShellState, handleBash, handleSkillBash, handleKillShell, } from "./tools-shell.js";
import { handleWebFetch, handleWebSearch } from "./tools-web.js";
import { createStateContext, handleTodoWrite, handleTestWrite, handleTask, handleTaskOutput, } from "./tools-state.js";
import { handleAskUser, handleRequestCredential } from "./tools-user.js";
export const createToolHost = ({ StellaHome, requestCredential, resolveSecret }) => {
    const stateRoot = path.join(StellaHome, "state");
    const pluginsRoot = path.join(StellaHome, "plugins");
    // Plugin state
    const pluginHandlers = new Map();
    let pluginSyncPayload = {
        plugins: [],
        tools: [],
        skills: [],
        agents: [],
    };
    // User tools config
    const userConfig = { requestCredential };
    // Secret resolution helper for shell tools
    const resolveSecretValue = async (spec, cache) => {
        if (cache.has(spec.provider)) {
            return cache.get(spec.provider) ?? null;
        }
        if (!resolveSecret)
            return null;
        let resolved = await resolveSecret({ provider: spec.provider });
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
    const loadPlugins = async () => {
        log("Loading plugins from:", pluginsRoot);
        const loaded = await loadPluginsFromHome(pluginsRoot);
        pluginHandlers.clear();
        for (const [name, handler] of loaded.handlers.entries()) {
            log("Registering plugin handler:", name);
            pluginHandlers.set(name, handler);
        }
        log("Total plugin handlers registered:", pluginHandlers.size);
        pluginSyncPayload = {
            plugins: loaded.plugins,
            tools: loaded.tools.map((tool) => ({
                pluginId: tool.pluginId,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                source: tool.source,
            })),
            skills: loaded.skills,
            agents: loaded.agents,
        };
        return pluginSyncPayload;
    };
    const notConfigured = (name) => ({
        result: `${name} is not configured on this device yet.`,
    });
    // Handler registry
    const handlers = {
        // File tools
        Read: (args) => handleRead(args),
        Write: (args) => handleWrite(args),
        Edit: (args) => handleEdit(args),
        // Search tools
        Glob: (args) => handleGlob(args),
        Grep: (args) => handleGrep(args),
        // Shell tools
        Bash: (args, context) => handleBash(shellState, args, context),
        SkillBash: (args) => handleSkillBash(shellState, args),
        KillShell: (args) => handleKillShell(shellState, args),
        // Web tools
        WebFetch: (args) => handleWebFetch(args),
        WebSearch: (args) => handleWebSearch(args),
        // State tools
        TodoWrite: (args, context) => handleTodoWrite(stateContext, args, context),
        TestWrite: (args, context) => handleTestWrite(stateContext, args, context),
        Task: (args) => handleTask(stateContext, args),
        TaskOutput: (args) => handleTaskOutput(stateContext, args),
        // User tools
        AskUserQuestion: (args) => handleAskUser(args),
        RequestCredential: (args) => handleRequestCredential(userConfig, args),
        // Database tools
        SqliteQuery: (args, context) => handleSqliteQuery(args, context),
        // Placeholder tools (not yet implemented)
        ImageGenerate: async () => notConfigured("ImageGenerate"),
        ImageEdit: async () => notConfigured("ImageEdit"),
        VideoGenerate: async () => notConfigured("VideoGenerate"),
    };
    const executeTool = async (toolName, toolArgs, context) => {
        log(`Executing tool: ${toolName}`, {
            args: toolName.includes("hera-browser")
                ? { code: toolArgs.code?.slice(0, 200) + "...", timeout: toolArgs.timeout }
                : toolArgs,
            context,
        });
        const handler = handlers[toolName] ?? pluginHandlers.get(toolName);
        if (!handler) {
            const availableTools = [
                ...Object.keys(handlers),
                ...Array.from(pluginHandlers.keys()),
            ];
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
    return {
        executeTool,
        getShells: () => Array.from(shellState.shells.values()),
        loadPlugins,
        getPluginSyncPayload: () => pluginSyncPayload,
        setSkills,
    };
};
