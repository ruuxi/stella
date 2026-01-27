import { ipcMain } from "electron";
export const createScreenBridge = (options) => {
    const invokeTimeoutMs = Math.max(5000, Math.floor(options.invokeTimeoutMs ?? 30000));
    const pendingInvoke = new Map();
    const pendingList = new Map();
    const resolvePending = (map, payload) => {
        const pending = map.get(payload.requestId);
        if (!pending) {
            return false;
        }
        clearTimeout(pending.timeout);
        map.delete(payload.requestId);
        pending.resolve(payload);
        return true;
    };
    ipcMain.on("screen:result", (_event, payload) => {
        resolvePending(pendingInvoke, payload);
    });
    ipcMain.on("screen:list-result", (_event, payload) => {
        resolvePending(pendingList, payload);
    });
    const invokeScreenCommand = async (input) => {
        const target = options.getTargetWindow();
        if (!target) {
            return { ok: false, error: "No target window available for screen commands." };
        }
        const requestId = input.requestId?.trim() || crypto.randomUUID();
        const request = {
            requestId,
            screenId: input.screenId,
            command: input.command,
            args: input.args ?? {},
            conversationId: input.conversationId,
            deviceId: input.deviceId,
        };
        const resultPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingInvoke.delete(requestId);
                reject(new Error(`Screen command timed out after ${invokeTimeoutMs}ms.`));
            }, invokeTimeoutMs);
            pendingInvoke.set(requestId, { resolve, reject, timeout });
        });
        target.webContents.send("screen:invoke", request);
        try {
            const result = await resultPromise;
            return result.ok ? { ok: true, result: result.result } : { ok: false, error: result.error };
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
    };
    const listScreens = async (input) => {
        const target = options.getTargetWindow();
        if (!target) {
            return { ok: false, error: "No target window available for listing screens." };
        }
        const requestId = crypto.randomUUID();
        const request = {
            requestId,
            conversationId: input.conversationId,
            deviceId: input.deviceId,
        };
        const resultPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingList.delete(requestId);
                reject(new Error(`Screen list timed out after ${invokeTimeoutMs}ms.`));
            }, invokeTimeoutMs);
            pendingList.set(requestId, { resolve, reject, timeout });
        });
        target.webContents.send("screen:list-request", request);
        try {
            const result = await resultPromise;
            return result.ok
                ? { ok: true, screens: result.screens ?? [] }
                : { ok: false, error: result.error };
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
    };
    return {
        invokeScreenCommand,
        listScreens,
    };
};
