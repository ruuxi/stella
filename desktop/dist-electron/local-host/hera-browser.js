import { PlaywrightExecutor } from "hera-browser/dist/executor.js";
const log = (...args) => console.log("[hera-browser]", ...args);
const logError = (...args) => console.error("[hera-browser]", ...args);
// Single executor instance (created lazily)
let executor = null;
const logger = {
    log: (...args) => log(...args),
    error: (...args) => logError(...args),
};
async function getOrCreateExecutor() {
    if (executor) {
        log("Reusing existing executor instance");
        return executor;
    }
    log("Creating new PlaywrightExecutor instance...");
    const host = process.env.HERA_BROWSER_HOST;
    const token = process.env.HERA_BROWSER_TOKEN;
    log("CDP configuration:", {
        hasHost: !!host,
        host: host || "(local)",
        port: 9224,
        hasToken: !!token,
    });
    const cdpConfig = host
        ? { host, port: 9224, token }
        : { port: 9224 };
    try {
        executor = new PlaywrightExecutor({
            cdpConfig,
            logger,
            cwd: process.cwd(),
        });
        log("PlaywrightExecutor created successfully");
    }
    catch (error) {
        logError("Failed to create PlaywrightExecutor:", error);
        throw error;
    }
    return executor;
}
const handleExecute = async (args) => {
    const code = String(args.code ?? "");
    const timeout = Number(args.timeout ?? 10000);
    log("Execute request received", {
        codeLength: code.length,
        codePreview: code.slice(0, 200) + (code.length > 200 ? "..." : ""),
        timeout,
    });
    if (!code.trim()) {
        logError("Empty code provided");
        return { error: "code is required" };
    }
    try {
        log("Getting executor...");
        const exec = await getOrCreateExecutor();
        log("Executing code...");
        const startTime = Date.now();
        const result = await exec.execute(code, timeout);
        const duration = Date.now() - startTime;
        log("Execution completed", {
            duration,
            textLength: result.text?.length,
            imageCount: result.images?.length ?? 0,
            isError: result.isError,
        });
        // Format result for Stella
        let output = result.text;
        if (result.images && result.images.length > 0) {
            output += `\n\n[${result.images.length} screenshot(s) captured]`;
        }
        if (result.isError) {
            logError("Execution returned error:", output?.slice(0, 500));
            return { error: output };
        }
        log("Execution successful, result preview:", output?.slice(0, 300));
        return { result: output };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logError("Execution threw exception:", {
            message,
            stack: stack?.slice(0, 500),
        });
        return {
            error: `Error executing code: ${message}\n\n[HINT: If this is a connection error, use the hera-browser.reset tool to reconnect.]`,
        };
    }
};
const handleReset = async () => {
    log("Reset requested");
    try {
        const exec = await getOrCreateExecutor();
        log("Calling executor.reset()...");
        const startTime = Date.now();
        const { page, context } = await exec.reset();
        const duration = Date.now() - startTime;
        const pagesCount = context.pages().length;
        const currentUrl = page.url();
        log("Reset completed", {
            duration,
            pagesCount,
            currentUrl,
        });
        return {
            result: `Connection reset successfully. ${pagesCount} page(s) available. Current page URL: ${currentUrl}`,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logError("Reset failed:", {
            message,
            stack: stack?.slice(0, 500),
        });
        return { error: `Failed to reset connection: ${message}` };
    }
};
export const HERA_BROWSER_TOOL_DESCRIPTORS = [
    {
        pluginId: "hera-browser",
        name: "hera-browser.execute",
        description: `Execute Playwright code to control Chrome browser. The code runs with {page, state, context} in scope.

Best practices:
- Use accessibilitySnapshot({ page }) to find elements, then interact via aria-ref
- Use screenshotWithAccessibilityLabels({ page }) for visual layouts (grids, dashboards)
- Store pages in state: state.myPage = await context.newPage()
- Check page state after actions: console.log('url:', page.url())
- Prefer single-line code with semicolons between statements
- Use multiple execute calls for complex logic

Available utilities:
- accessibilitySnapshot({ page, search?, showDiffSinceLastCall? })
- screenshotWithAccessibilityLabels({ page })
- getCleanHTML({ locator, search?, showDiffSinceLastCall? })
- waitForPageLoad({ page, timeout? })
- getCDPSession({ page })
- getLatestLogs({ page?, count?, search? })

Example:
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
console.log(await accessibilitySnapshot({ page }));`,
        inputSchema: {
            type: "object",
            properties: {
                code: {
                    type: "string",
                    description: "Playwright code to execute. Has {page, state, context} in scope. Use semicolons for multiple statements.",
                },
                timeout: {
                    type: "number",
                    description: "Timeout in milliseconds (default: 10000)",
                },
            },
            required: ["code"],
        },
        source: "builtin",
    },
    {
        pluginId: "hera-browser",
        name: "hera-browser.reset",
        description: `Reset the browser connection. Use when:
- MCP stops responding
- Connection errors occur
- No pages in context
- Page closed errors
- Assertion failures

This clears the state object and reconnects to the browser.`,
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
        source: "builtin",
    },
];
export const HERA_BROWSER_HANDLERS = new Map([
    ["hera-browser.execute", handleExecute],
    ["hera-browser.reset", handleReset],
]);
export const HERA_BROWSER_PLUGIN = {
    id: "hera-browser",
    name: "Hera Browser",
    version: "0.0.56",
    description: "Control Chrome browser via Playwright. Automate web interactions, take screenshots, and inspect accessibility trees.",
    source: "builtin",
};
export const HERA_BROWSER_SKILL = {
    id: "hera-browser",
    name: "Hera Browser",
    description: "Control Chrome browser via Playwright code snippets. Automate web interactions, take screenshots, inspect accessibility trees, and debug web applications.",
    markdown: `# hera-browser best practices

Control user's Chrome browser via playwright code snippets. Prefer single-line code with semicolons between statements. If you get "extension is not connected" or "no browser tabs have Hera Browser enabled" error, tell user to click the hera-browser extension icon on the tab they want to control.

## context variables

- \`state\` - object persisted between calls within your session. Use to store pages, data, listeners
- \`page\` - default page the user activated
- \`context\` - browser context, access all pages via \`context.pages()\`

## rules

- Use multiple execute calls for complex logic - helps understand intermediate state
- Never call \`browser.close()\` or \`context.close()\`
- Check state after actions: \`console.log('url:', page.url())\`

## accessibility snapshots

\`\`\`js
await accessibilitySnapshot({ page, search?, showDiffSinceLastCall? })
\`\`\`

Use \`aria-ref\` to interact:
\`\`\`js
await page.locator('aria-ref=e13').click()
\`\`\`

## screenshots with labels

\`\`\`js
await screenshotWithAccessibilityLabels({ page });
\`\`\`

Use for pages with grids, image galleries, or complex visual layouts.

## common patterns

**Navigation:**
\`\`\`js
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
await waitForPageLoad({ page, timeout: 5000 });
\`\`\`

**Finding elements:**
\`\`\`js
const snapshot = await accessibilitySnapshot({ page, search: /button|submit/i });
\`\`\`

**Multiple pages:**
\`\`\`js
state.myPage = await context.newPage();
await state.myPage.goto('https://example.com');
\`\`\`

## utility functions

- \`accessibilitySnapshot({ page, search?, showDiffSinceLastCall? })\` - get page structure
- \`screenshotWithAccessibilityLabels({ page })\` - visual screenshot with labels
- \`getCleanHTML({ locator, search? })\` - get cleaned HTML
- \`waitForPageLoad({ page, timeout? })\` - smart load detection
- \`getCDPSession({ page })\` - send raw CDP commands
- \`getLatestLogs({ page?, count?, search? })\` - browser console logs`,
    agentTypes: ["browser", "general"],
    toolsAllowlist: ["hera-browser_execute", "hera-browser_reset"],
    tags: ["browser", "automation", "playwright"],
    version: 1,
    source: "builtin",
    filePath: "builtin:hera-browser",
};
