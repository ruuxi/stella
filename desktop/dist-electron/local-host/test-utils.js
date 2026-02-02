/**
 * Mock Tool Host Factory
 * Creates a configurable mock tool host for testing
 */
export function createMockToolHost(responses) {
    const callHistory = [];
    const defaultResponses = new Map([
        ["Bash", { result: "Command completed successfully" }],
        ["Read", { result: "File content here" }],
        ["Glob", { result: "Found 0 files" }],
        ["Grep", { result: "No matches found" }],
        ["SqliteQuery", { result: JSON.stringify([]) }],
    ]);
    const responseMap = responses ? new Map([...defaultResponses, ...responses]) : defaultResponses;
    return {
        executeTool: async (toolName, toolArgs, context) => {
            callHistory.push({ name: toolName, args: toolArgs, ctx: context });
            const handler = responseMap.get(toolName);
            if (!handler) {
                return { error: `Unknown tool: ${toolName}` };
            }
            if (typeof handler === "function") {
                return handler(toolArgs, context);
            }
            return handler;
        },
        callHistory,
    };
}
