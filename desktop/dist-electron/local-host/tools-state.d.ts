/**
 * State tools: Task, TaskOutput handlers.
 */
import type { ToolResult, TaskRecord } from "./tools-types.js";
export type StateContext = {
    stateRoot: string;
    tasks: Map<string, TaskRecord>;
};
export declare const createStateContext: (stateRoot: string) => StateContext;
export declare const handleTask: (ctx: StateContext, args: Record<string, unknown>) => Promise<ToolResult>;
export declare const handleTaskOutput: (ctx: StateContext, args: Record<string, unknown>) => Promise<ToolResult>;
