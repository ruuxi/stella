import { ConvexClient } from "convex/browser";
import { createToolHost } from "./tools.js";
import { loadSkillsFromHome } from "./skills.js";
import { loadAgentsFromHome } from "./agents.js";
import { syncExternalSkills, syncBundledSkills } from "./skill_import.js";
import { syncBundledCommands } from "./command_sync.js";
import { loadSyncManifest, saveSyncManifest, diffSkills, diffAgents, applyDiffToManifest, } from "./sync_manifest.js";
import { loadIdentityMap, depseudonymize } from "./identity_map.js";
import { purgeExpiredDeferredDeletes } from "./deferred_delete.js";
import { sanitizeForLogs } from "./tools-utils.js";
import path from "path";
import fs from "fs";
import os from "os";
const log = (...args) => console.log("[runner]", ...args.map((entry) => sanitizeForLogs(entry)));
const logError = (...args) => console.error("[runner]", ...args.map((entry) => sanitizeForLogs(entry)));
const SYNC_DEBOUNCE_MS = 500;
const DISCOVERY_CATEGORIES_STATE_FILE = "discovery_categories.json";
const MESSAGES_NOTES_CATEGORY = "messages_notes";
const DISCOVERY_CATEGORY_CACHE_TTL_MS = 5000;
const DEFERRED_DELETE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const createLocalHostRunner = ({ deviceId, StellaHome, frontendRoot, requestCredential }) => {
    const toolHost = createToolHost({
        StellaHome,
        frontendRoot,
        requestCredential,
        resolveSecret: async ({ provider, secretId, requestId, toolName, deviceId: contextDeviceId }) => {
            if (!client)
                return null;
            if (!requestId || !toolName)
                return null;
            if (secretId) {
                return (await callQuery("data/secrets.getSecretValueById", {
                    secretId,
                    requestId,
                    toolName,
                    deviceId: contextDeviceId ?? deviceId,
                }));
            }
            return (await callQuery("data/secrets.getSecretValueForProvider", {
                provider,
                requestId,
                toolName,
                deviceId: contextDeviceId ?? deviceId,
            }));
        },
    });
    let client = null;
    let convexUrl = null;
    let authToken = null;
    let unsubscribe = null;
    let isRunning = false;
    const processed = new Set();
    const inFlight = new Set();
    let queue = Promise.resolve();
    let syncPromise = null;
    let syncDebounceTimer = null;
    const watchers = [];
    let deferredDeleteSweepInterval = null;
    let heartbeatInterval = null;
    const HEARTBEAT_INTERVAL_MS = 30000;
    const sendHeartbeat = () => {
        callMutation("agent/device_resolver.heartbeat", {
            deviceId,
            platform: process.platform,
        }).catch((err) => logError("Heartbeat failed:", err));
    };
    const startHeartbeat = () => {
        if (heartbeatInterval)
            return;
        sendHeartbeat();
        heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    };
    const stopHeartbeat = () => {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        // Best-effort goOffline — fire and forget
        callMutation("agent/device_resolver.goOffline", {}).catch(() => { });
    };
    const sweepDeferredDeletes = async (reason) => {
        try {
            const summary = await purgeExpiredDeferredDeletes({ stellaHome: StellaHome });
            if (summary.purged > 0 || summary.errors.length > 0) {
                log("Deferred-delete sweep complete", {
                    reason,
                    purged: summary.purged,
                    checked: summary.checked,
                    skipped: summary.skipped,
                    errors: summary.errors,
                });
            }
        }
        catch (error) {
            logError(`Deferred-delete sweep failed (${reason}):`, error);
        }
    };
    const skillsPath = path.join(StellaHome, "skills");
    const agentsPath = path.join(StellaHome, "agents");
    const statePath = path.join(StellaHome, "state");
    const discoveryCategoriesPath = path.join(statePath, DISCOVERY_CATEGORIES_STATE_FILE);
    // External skill sources
    const claudeSkillsPath = path.join(os.homedir(), ".claude", "skills");
    const agentsSkillsPath = path.join(os.homedir(), ".agents", "skills");
    // Bundled Anthropic skills (shipped with the app)
    // Dev: frontendRoot/resources/bundled-skills
    // Prod: extraResources copied to process.resourcesPath/bundled-skills
    const bundledSkillsPath = (() => {
        if (frontendRoot) {
            const devPath = path.join(frontendRoot, "resources", "bundled-skills");
            if (fs.existsSync(devPath))
                return devPath;
        }
        try {
            const prodPath = path.join(process.resourcesPath, "bundled-skills");
            if (fs.existsSync(prodPath))
                return prodPath;
        }
        catch {
            // process.resourcesPath may not exist outside Electron
        }
        return null;
    })();
    // Bundled commands (shipped with the app)
    // Dev: frontendRoot/resources/bundled-commands
    // Prod: extraResources copied to process.resourcesPath/bundled-commands
    const bundledCommandsPath = (() => {
        if (frontendRoot) {
            const devPath = path.join(frontendRoot, "resources", "bundled-commands");
            if (fs.existsSync(devPath))
                return devPath;
        }
        try {
            const prodPath = path.join(process.resourcesPath, "bundled-commands");
            if (fs.existsSync(prodPath))
                return prodPath;
        }
        catch {
            // process.resourcesPath may not exist outside Electron
        }
        return null;
    })();
    const toConvexName = (name) => {
        // Convex expects "module:function" identifiers, not dot-separated paths.
        const firstDot = name.indexOf(".");
        if (firstDot === -1)
            return name;
        return `${name.slice(0, firstDot)}:${name.slice(firstDot + 1)}`;
    };
    const callMutation = (name, args) => {
        if (!client || !authToken)
            return Promise.resolve(null);
        const convexName = toConvexName(name);
        return client.mutation(convexName, args);
    };
    const callQuery = (name, args) => {
        if (!client || !authToken)
            return Promise.resolve(null);
        const convexName = toConvexName(name);
        return client.query(convexName, args);
    };
    const subscribeQuery = (name, args, onUpdate) => {
        if (!client || !authToken)
            return null;
        const convexName = toConvexName(name);
        return client.onUpdate(convexName, args, (value) => {
            onUpdate(value);
        });
    };
    const generateMetadataViaBackend = async (markdown, dirName) => {
        if (!convexUrl || !authToken) {
            throw new Error("Convex not configured");
        }
        const httpBaseUrl = convexUrl.replace(".convex.cloud", ".convex.site");
        const response = await fetch(`${httpBaseUrl}/api/generate-skill-metadata`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({ markdown, skillDirName: dirName }),
        });
        if (!response.ok) {
            throw new Error(`Failed to generate metadata: ${response.status}`);
        }
        return response.json();
    };
    const syncManifests = async () => {
        if (!client)
            return;
        if (syncPromise)
            return syncPromise;
        syncPromise = (async () => {
            try {
                log("Syncing manifests...");
                await callMutation("agent/agents.ensureBuiltins", {});
                // Import bundled Anthropic skills first (disabled by default, no LLM call needed)
                if (bundledSkillsPath) {
                    try {
                        await syncBundledSkills(bundledSkillsPath, skillsPath, statePath);
                    }
                    catch (error) {
                        logError("Bundled skill import failed:", error);
                    }
                }
                // Import bundled commands (disabled by default, no LLM call needed)
                if (bundledCommandsPath) {
                    try {
                        await syncBundledCommands(bundledCommandsPath, callMutation);
                    }
                    catch (error) {
                        logError("Bundled command import failed:", error);
                    }
                }
                // Import skills from external sources
                if (convexUrl && authToken) {
                    try {
                        await syncExternalSkills(claudeSkillsPath, agentsSkillsPath, skillsPath, statePath, generateMetadataViaBackend);
                    }
                    catch (error) {
                        logError("External skill import failed:", error);
                        // Continue with manifest sync even if import fails
                    }
                }
                const skills = await loadSkillsFromHome(skillsPath);
                const agents = await loadAgentsFromHome(agentsPath);
                toolHost.setSkills(skills);
                // Diff against persisted manifest to skip unchanged items
                const manifest = await loadSyncManifest(statePath);
                const skillsDiff = diffSkills(skills, manifest);
                const agentsDiff = diffAgents(agents, manifest);
                const dirtySkills = skillsDiff.upsert.length;
                const dirtyAgents = agentsDiff.upsert.length;
                const removedSkills = skillsDiff.removeIds.length;
                const removedAgents = agentsDiff.removeIds.length;
                if (dirtySkills === 0 && dirtyAgents === 0 && removedSkills === 0 && removedAgents === 0) {
                    log("Manifest sync complete (no changes)");
                    return;
                }
                if (dirtySkills > 0) {
                    log(`Syncing ${dirtySkills} changed skill(s)`);
                    await callMutation("data/skills.upsertMany", {
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        skills: skillsDiff.upsert.map(({ filePath: _, ...rest }) => rest),
                    });
                }
                if (dirtyAgents > 0) {
                    log(`Syncing ${dirtyAgents} changed agent(s)`);
                    await callMutation("agent/agents.upsertMany", {
                        agents: agentsDiff.upsert,
                    });
                }
                if (removedSkills > 0) {
                    log(`Removed ${removedSkills} skill(s) from manifest (deleted from disk)`);
                }
                if (removedAgents > 0) {
                    log(`Removed ${removedAgents} agent(s) from manifest (deleted from disk)`);
                }
                // Persist updated manifest only after successful sync
                const updatedManifest = applyDiffToManifest(manifest, skillsDiff, agentsDiff);
                await saveSyncManifest(statePath, updatedManifest);
                log("Manifest sync complete");
            }
            catch (error) {
                logError("Manifest sync failed:", error);
                // Best-effort sync; ignore failures and retry later.
            }
            finally {
                syncPromise = null;
            }
        })();
        return syncPromise;
    };
    const scheduleSyncManifests = () => {
        // Debounce file change events to avoid syncing too frequently
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
        }
        syncDebounceTimer = setTimeout(() => {
            syncDebounceTimer = null;
            void syncManifests();
        }, SYNC_DEBOUNCE_MS);
    };
    const startWatchers = () => {
        // Only watch ~/.stella/skills and ~/.stella/agents for runtime changes.
        // External sources (.claude, .agents) and bundled skills are one-time imports
        // handled by syncManifests — no need to watch them.
        const watchDirs = [skillsPath, agentsPath];
        for (const dir of watchDirs) {
            if (!fs.existsSync(dir)) {
                try {
                    fs.mkdirSync(dir, { recursive: true });
                }
                catch {
                    logError(`Failed to create directory: ${dir}`);
                    continue;
                }
            }
            try {
                const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
                    if (syncPromise)
                        return; // Ignore events triggered by our own sync
                    log(`File change: ${filename} in ${path.basename(dir)}`);
                    scheduleSyncManifests();
                });
                watcher.on("error", (error) => {
                    logError(`Watcher error for ${dir}:`, error);
                });
                watchers.push(watcher);
                log(`Watching for changes: ${dir}`);
            }
            catch (error) {
                logError(`Failed to watch directory ${dir}:`, error);
            }
        }
    };
    const stopWatchers = () => {
        for (const watcher of watchers) {
            watcher.close();
        }
        watchers.length = 0;
    };
    const stopSubscription = () => {
        if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
            log("Tool request subscription stopped");
        }
    };
    const startSubscription = () => {
        // Only start subscription if we have client, auth, and not already subscribed
        if (!client || !authToken || unsubscribe)
            return;
        // Use current timestamp to filter out historical requests
        // Only requests created AFTER this moment will be received
        const since = Date.now();
        log("Starting tool request subscription for device:", deviceId, { since });
        // Use onUpdate for real-time subscription to tool requests
        // The subscription will automatically receive updates when new tool requests are created
        unsubscribe = client.onUpdate("events:listToolRequestsForDevice", { deviceId, paginationOpts: { cursor: null, numItems: 20 }, since }, (response) => {
            if (!response || typeof response !== "object" || !("page" in response)) {
                return;
            }
            const result = response;
            for (const request of result.page) {
                queue = queue.then(() => handleToolRequest(request)).catch(() => undefined);
            }
        });
        log("Tool request subscription active - receiving only new requests");
    };
    const setConvexUrl = (url) => {
        if (convexUrl === url && client) {
            return;
        }
        // Stop existing subscription before changing client
        stopSubscription();
        convexUrl = url;
        // Close existing client if any
        if (client) {
            client.close();
        }
        client = new ConvexClient(url);
        if (authToken) {
            client.setAuth(() => Promise.resolve(authToken));
        }
        void syncManifests();
        // Restart subscription with new client if runner is running (and auth is set)
        if (isRunning) {
            startSubscription();
        }
    };
    const setAuthToken = (token) => {
        authToken = token;
        if (!client) {
            return;
        }
        if (authToken) {
            client.setAuth(() => Promise.resolve(authToken));
            // Start subscription if runner is running and we now have auth.
            // Note: avoid restarting an active subscription on token refresh; Convex
            // will re-authenticate as needed via the updated auth callback.
            if (isRunning) {
                startSubscription();
                // Send immediate heartbeat when auth becomes available
                sendHeartbeat();
            }
        }
        else {
            // Stop subscription when auth is cleared (logout/unauthenticated).
            stopSubscription();
            // Clear auth by setting it to return null
            client.setAuth(() => Promise.resolve(null));
        }
    };
    // Identity map cache for depseudonymizing tool arguments
    let identityMapCache = null;
    let messagesNotesEnabledCache = null;
    const getIdentityMapCached = async () => {
        if (identityMapCache)
            return identityMapCache;
        identityMapCache = await loadIdentityMap(StellaHome);
        return identityMapCache;
    };
    const isMessagesNotesDiscoveryEnabled = async () => {
        const now = Date.now();
        if (messagesNotesEnabledCache &&
            now - messagesNotesEnabledCache.checkedAt < DISCOVERY_CATEGORY_CACHE_TTL_MS) {
            return messagesNotesEnabledCache.value;
        }
        try {
            const raw = await fs.promises.readFile(discoveryCategoriesPath, "utf-8");
            const parsed = JSON.parse(raw);
            const categories = Array.isArray(parsed)
                ? parsed
                : parsed &&
                    typeof parsed === "object" &&
                    Array.isArray(parsed.categories)
                    ? parsed.categories
                    : [];
            const enabled = categories.includes(MESSAGES_NOTES_CATEGORY);
            messagesNotesEnabledCache = { value: enabled, checkedAt: now };
            return enabled;
        }
        catch {
            messagesNotesEnabledCache = { value: false, checkedAt: now };
            return false;
        }
    };
    const depseudonymizeArgs = (args, map) => {
        if (!map.mappings.length)
            return args;
        const result = {};
        for (const [key, value] of Object.entries(args)) {
            if (typeof value === "string") {
                result[key] = depseudonymize(value, map);
            }
            else if (Array.isArray(value)) {
                result[key] = value.map((v) => typeof v === "string" ? depseudonymize(v, map) : v);
            }
            else if (value && typeof value === "object") {
                result[key] = depseudonymizeArgs(value, map);
            }
            else {
                result[key] = value;
            }
        }
        return result;
    };
    const appendToolResult = async (request, result) => {
        if (!client || !request.requestId)
            return;
        const sanitizedResult = sanitizeForLogs(result.result);
        const sanitizedError = typeof result.error === "string"
            ? String(sanitizeForLogs(result.error))
            : result.error;
        await callMutation("events.appendEvent", {
            conversationId: request.conversationId,
            type: "tool_result",
            deviceId,
            requestId: request.requestId,
            targetDeviceId: request.targetDeviceId,
            payload: {
                toolName: request.payload?.toolName,
                result: sanitizedResult,
                error: sanitizedError,
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
        const toolName = request.payload?.toolName;
        log(`Received tool request: ${toolName}`, {
            requestId: request.requestId,
            conversationId: request.conversationId,
        });
        inFlight.add(request.requestId);
        try {
            const existing = await callQuery("events.getToolResult", {
                requestId: request.requestId,
                deviceId,
            });
            if (existing) {
                log(`Tool request ${request.requestId} already processed, skipping`);
                processed.add(request.requestId);
                return;
            }
            let toolArgs = request.payload?.args ?? {};
            if (!toolName) {
                logError("Tool request missing toolName:", request);
                await appendToolResult(request, { error: "toolName missing on request." });
                processed.add(request.requestId);
                return;
            }
            // Depseudonymize tool args: replace alias names/identifiers with real values
            // so tools operate on actual data (e.g., real contact names for iMessage queries)
            const messagesNotesEnabled = await isMessagesNotesDiscoveryEnabled();
            if (messagesNotesEnabled) {
                const idMap = await getIdentityMapCached();
                if (idMap.mappings.length > 0) {
                    toolArgs = depseudonymizeArgs(toolArgs, idMap);
                }
            }
            log(`Executing tool: ${toolName}`, {
                argsPreview: JSON.stringify(sanitizeForLogs(toolArgs)).slice(0, 200),
            });
            const startTime = Date.now();
            const toolResult = await toolHost.executeTool(toolName, toolArgs, {
                conversationId: request.conversationId,
                deviceId,
                requestId: request.requestId,
                agentType: request.payload?.agentType,
            });
            const duration = Date.now() - startTime;
            log(`Tool ${toolName} completed in ${duration}ms`, {
                hasResult: "result" in toolResult,
                hasError: "error" in toolResult,
                errorPreview: toolResult.error?.slice(0, 300),
            });
            await appendToolResult(request, toolResult);
            processed.add(request.requestId);
        }
        catch (error) {
            logError(`Tool request ${toolName} failed with exception:`, error);
            await appendToolResult(request, {
                error: `Tool execution failed: ${error.message}`,
            });
            processed.add(request.requestId);
        }
        finally {
            inFlight.delete(request.requestId);
        }
    };
    const start = () => {
        if (isRunning)
            return;
        isRunning = true;
        log("Starting local host runner", { deviceId, StellaHome });
        // Purge expired deferred-deletion entries (survives app restarts).
        void sweepDeferredDeletes("startup");
        if (!deferredDeleteSweepInterval) {
            deferredDeleteSweepInterval = setInterval(() => {
                void sweepDeferredDeletes("interval");
            }, DEFERRED_DELETE_SWEEP_INTERVAL_MS);
        }
        // Initial sync on startup, then start file watchers after sync completes
        // (avoids watcher triggering on files the sync itself creates)
        void syncManifests().then(() => startWatchers());
        // Start real-time subscription for tool requests (only if auth is ready)
        startSubscription();
        // Start device heartbeat (only sends if auth is available)
        startHeartbeat();
    };
    const stop = () => {
        isRunning = false;
        if (deferredDeleteSweepInterval) {
            clearInterval(deferredDeleteSweepInterval);
            deferredDeleteSweepInterval = null;
        }
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
            syncDebounceTimer = null;
        }
        stopHeartbeat();
        stopWatchers();
        stopSubscription();
        if (client) {
            client.close();
            client = null;
        }
    };
    // Expose tool execution for external callers
    const executeTool = async (toolName, toolArgs, context) => {
        return toolHost.executeTool(toolName, toolArgs, context);
    };
    return {
        deviceId,
        setConvexUrl,
        setAuthToken,
        start,
        stop,
        executeTool,
        subscribeQuery,
        getConvexUrl: () => convexUrl,
        getAuthToken: () => authToken,
        killAllShells: () => toolHost.killAllShells(),
        killShellsByPort: (port) => toolHost.killShellsByPort(port),
    };
};
