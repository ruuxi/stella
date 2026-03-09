/**
 * Compatibility shim for generated Convex bindings that still reference ai_proxy.
 * The managed execution endpoint now lives in managed_execution.ts.
 */

export { managedExecution as managedAi } from "./managed_execution";
