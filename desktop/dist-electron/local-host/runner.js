import { ConvexHttpClient } from "convex/browser";
import { createToolHost } from "./tools.js";
const POLL_INTERVAL_MS = 1500;
export const createLocalHostRunner = ({ deviceId, userDataPath }) => {
    const toolHost = createToolHost({ userDataPath });
    let client = null;
    let convexUrl = null;
    let pollTimer = null;
    const processed = new Set();
    const inFlight = new Set();
    let queue = Promise.resolve();
    const setConvexUrl = (url) => {
        if (convexUrl === url && client) {
            return;
        }
        convexUrl = url;
        client = new ConvexHttpClient(url, { logger: false });
    };
    const appendToolResult = async (request, result) => {
        if (!client || !request.requestId)
            return;
        await client.mutation("events.appendEvent", {
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
            const existing = await client.query("events.getToolResult", {
                requestId: request.requestId,
                deviceId,
            });
            if (existing) {
                processed.add(request.requestId);
                return;
            }
            const toolName = request.payload?.toolName;
            const toolArgs = request.payload?.args ?? {};
            if (!toolName) {
                await appendToolResult(request, { error: "toolName missing on request." });
                processed.add(request.requestId);
                return;
            }
            const toolResult = await toolHost.executeTool(toolName, toolArgs, {
                conversationId: request.conversationId,
                deviceId,
                requestId: request.requestId,
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
        const result = (await client.query("events.listToolRequestsForDevice", {
            deviceId,
            paginationOpts: { cursor: null, numItems: 20 },
        }));
        for (const request of result.page) {
            queue = queue.then(() => handleToolRequest(request)).catch(() => undefined);
        }
    };
    const start = () => {
        if (pollTimer)
            return;
        pollTimer = setInterval(() => {
            void pollOnce();
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
