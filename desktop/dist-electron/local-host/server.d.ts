/**
 * Local HTTP server (Hono) — serves all local-first API endpoints.
 * Runs on localhost:9714 in the Electron main process.
 * Replaces Convex live queries and mutations for local data.
 */
import { Hono } from "hono";
import { type RuntimeConfig } from "./agent/runtime";
export declare function setRuntimeConfig(config: RuntimeConfig): void;
declare function broadcastSSE(conversationId: string, event: string, data: unknown): void;
declare function broadcastGlobal(event: string, data: unknown): void;
declare const app: Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
export declare const DEFAULT_PORT = 9714;
export declare function startLocalServer(port?: number): Promise<number>;
export declare function stopLocalServer(): void;
export { broadcastSSE, broadcastGlobal, app, };
