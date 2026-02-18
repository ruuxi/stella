/**
 * Model failover — wraps AI SDK calls with automatic fallback.
 * Ported from backend/convex/agent/model_failover.ts
 */
function isAbortError(error) {
    if (error instanceof DOMException && error.name === "AbortError")
        return true;
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (msg.includes("abort") || msg.includes("cancel"))
            return true;
        if (error.name === "AbortError")
            return true;
    }
    return false;
}
function shouldFailover(error) {
    if (isAbortError(error))
        return false;
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (msg.includes("context") && (msg.includes("overflow") || msg.includes("too long") || msg.includes("too large"))) {
            return false;
        }
    }
    return true;
}
export function withModelFailover(primaryFn, fallbackFn) {
    try {
        return primaryFn();
    }
    catch (error) {
        if (!fallbackFn)
            throw error;
        if (!shouldFailover(error))
            throw error;
        console.warn(`[model-failover] Primary failed, attempting fallback. Error: ${error?.message ?? String(error)}`);
        return fallbackFn();
    }
}
export async function withModelFailoverAsync(primaryFn, fallbackFn) {
    try {
        return await primaryFn();
    }
    catch (error) {
        if (!fallbackFn)
            throw error;
        if (!shouldFailover(error))
            throw error;
        console.warn(`[model-failover] Primary failed, attempting fallback. Error: ${error?.message ?? String(error)}`);
        return await fallbackFn();
    }
}
