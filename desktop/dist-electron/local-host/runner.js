import { ConvexHttpClient } from "convex/browser";
import { createToolHost } from "./tools.js";
import { loadSkillsFromHome } from "./skills.js";
import { loadAgentsFromHome } from "./agents.js";
import path from "path";
const POLL_INTERVAL_MS = 1500;
export const createLocalHostRunner = ({ deviceId, stellarHome, projectRoot, screenBridge, onRevertPrompt, }) => {
    const toolHost = createToolHost({
        stellarHome,
        projectRoot,
        deviceId,
        screenBridge: screenBridge ?? null,
    });
    let client = null;
    let convexUrl = null;
    let pollTimer = null;
    const processed = new Set();
    const inFlight = new Set();
    let queue = Promise.resolve();
    let syncPromise = null;
    let lastSyncAt = 0;
    let startupChecked = false;
    const skillsPath = path.join(stellarHome, "skills");
    const agentsPath = path.join(stellarHome, "agents");
    const SYNC_MIN_INTERVAL_MS = 15000;
    const toConvexName = (name) => {
        // Convex expects "module:function" identifiers, not dot-separated paths.
        const firstDot = name.indexOf(".");
        if (firstDot === -1)
            return name;
        return `${name.slice(0, firstDot)}:${name.slice(firstDot + 1)}`;
    };
    const callMutation = (name, args) => {
        if (!client)
            return Promise.resolve(null);
        const convexName = toConvexName(name);
        return client.mutation(convexName, args);
    };
    const callQuery = (name, args) => {
        if (!client)
            return Promise.resolve(null);
        const convexName = toConvexName(name);
        return client.query(convexName, args);
    };
    const callAction = (name, args) => {
        if (!client)
            return Promise.resolve(null);
        const convexName = toConvexName(name);
        return client.action(convexName, args);
    };
    const updateConvexBridge = () => {
        toolHost.setConvexBridge(client
            ? {
                callMutation,
                callQuery,
                callAction,
            }
            : null);
    };
    const syncManifests = async () => {
        if (!client)
            return;
        const now = Date.now();
        if (syncPromise)
            return syncPromise;
        if (now - lastSyncAt < SYNC_MIN_INTERVAL_MS)
            return;
        syncPromise = (async () => {
            try {
                await callMutation("agents.ensureBuiltins", {});
                const pluginPayload = await toolHost.loadPlugins();
                const skills = await loadSkillsFromHome(skillsPath, pluginPayload.skills);
                const agents = await loadAgentsFromHome(agentsPath, pluginPayload.agents);
                await callMutation("skills.upsertMany", {
                    skills,
                });
                await callMutation("agents.upsertMany", {
                    agents,
                });
                await callMutation("plugins.upsertMany", {
                    plugins: pluginPayload.plugins,
                    tools: pluginPayload.tools,
                });
                lastSyncAt = Date.now();
            }
            catch {
                // Best-effort sync; ignore failures and retry later.
            }
            finally {
                syncPromise = null;
            }
        })();
        return syncPromise;
    };
    const setConvexUrl = (url) => {
        if (convexUrl === url && client) {
            return;
        }
        convexUrl = url;
        client = new ConvexHttpClient(url, { logger: false });
        updateConvexBridge();
        void syncManifests();
    };
    const appendToolResult = async (request, result) => {
        if (!client || !request.requestId)
            return;
        await callMutation("events.appendEvent", {
            conversationId: request.conversationId,
            type: "tool_result",
            deviceId,
            requestId: request.requestId,
            targetDeviceId: request.targetDeviceId,
            payload: {
                toolName: request.payload?.toolName,
                result: result.result,
                error: result.error,
                requestId: request.requestId,
                targetDeviceId: request.targetDeviceId,
            },
        });
    };
    const handleToolRequest = async (request) => {
        if (!client || request.type !== "tool_request" || !request.requestId) {
            return;
        }
        if (processed.has(request.requestId) || inFlight.has(request.requestId)) {
            return;
        }
        inFlight.add(request.requestId);
        try {
            const existing = await callQuery("events.getToolResult", {
                requestId: request.requestId,
                deviceId,
            });
            if (existing) {
                processed.add(request.requestId);
                return;
            }
            const toolName = request.payload?.toolName;
            const toolArgs = request.payload?.args ?? {};
            const agentType = request.payload?.agentType;
            if (!toolName) {
                await appendToolResult(request, { error: "toolName missing on request." });
                processed.add(request.requestId);
                return;
            }
            const toolResult = await toolHost.executeTool(toolName, toolArgs, {
                conversationId: request.conversationId,
                deviceId,
                requestId: request.requestId,
                agentType,
            });
            await appendToolResult(request, toolResult);
            processed.add(request.requestId);
        }
        catch (error) {
            await appendToolResult(request, {
                error: `Tool execution failed: ${error.message}`,
            });
            processed.add(request.requestId);
        }
        finally {
            inFlight.delete(request.requestId);
        }
    };
    const pollOnce = async () => {
        if (!client)
            return;
        try {
            const response = await callQuery("events.listToolRequestsForDevice", {
                deviceId,
                paginationOpts: { cursor: null, numItems: 20 },
            });
            if (!response || typeof response !== "object" || !("page" in response)) {
                return;
            }
            const result = response;
            for (const request of result.page) {
                queue = queue.then(() => handleToolRequest(request)).catch(() => undefined);
            }
        }
        catch {
            // Swallow polling errors; they will be retried on the next interval.
        }
    };
    const handleStartupChecks = async () => {
        const result = await toolHost.runStartupChecks();
        // Check if revert is needed and we have a callback
        if (result && "needsRevert" in result && result.needsRevert === true) {
            const { triggers, reason, bootId } = result;
            if (onRevertPrompt) {
                const shouldRevert = await onRevertPrompt({ triggers, reason });
                if (shouldRevert) {
                    await toolHost.performRevert(bootId, reason);
                }
                else {
                    await toolHost.skipRevert(bootId);
                }
            }
            else {
                // No callback provided - skip revert by default (dev mode behavior)
                await toolHost.skipRevert(bootId);
            }
        }
    };
    const start = () => {
        if (pollTimer)
            return;
        void syncManifests();
        if (!startupChecked) {
            startupChecked = true;
            void handleStartupChecks();
        }
        pollTimer = setInterval(() => {
            void pollOnce();
            void syncManifests();
        }, POLL_INTERVAL_MS);
    };
    const stop = () => {
        if (!pollTimer)
            return;
        clearInterval(pollTimer);
        pollTimer = null;
    };
    return {
        deviceId,
        setConvexUrl,
        start,
        stop,
    };
};
