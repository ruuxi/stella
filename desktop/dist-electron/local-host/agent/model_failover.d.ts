/**
 * Model failover — wraps AI SDK calls with automatic fallback.
 * Ported from backend/convex/agent/model_failover.ts
 */
export declare function withModelFailover<T>(primaryFn: () => T, fallbackFn?: () => T): T;
export declare function withModelFailoverAsync<T>(primaryFn: () => Promise<T>, fallbackFn?: () => Promise<T>): Promise<T>;
