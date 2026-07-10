import type { SkyClient } from "./client.js";

export const MAX_NODE_REPL_CODE_BYTES = 1 * 1024 * 1024;
export const MAX_NODE_REPL_OUTPUT_BYTES = 1 * 1024 * 1024;
export const MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_NODE_REPL_PENDING_SKY_CALLS = 64;
export const MAX_NODE_REPL_PENDING_BROWSER_CALLS = 64;

export type SkyMethod = keyof SkyClient;
export type BrowserMethod = "command" | "chain";

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
};

export type NodeReplWorkerData = {
  cwd: string;
  moduleUrl: string;
  maxCodeBytes: number;
  maxEvalOutputBytes: number;
  maxProtocolMessageBytes: number;
  maxPendingSkyCalls: number;
  maxPendingBrowserCalls: number;
};

export type ParentToNodeReplWorkerMessage =
  | { type: "evaluate"; evaluationId: number; code: string }
  | {
      type: "sky-result";
      callId: number;
      ok: true;
      value: unknown;
    }
  | {
      type: "sky-result";
      callId: number;
      ok: false;
      error: SerializedError;
    }
  | {
      type: "browser-result";
      callId: number;
      ok: true;
      value: unknown;
    }
  | {
      type: "browser-result";
      callId: number;
      ok: false;
      error: SerializedError;
    };

export type WorkerToNodeReplParentMessage =
  | { type: "ready" }
  | { type: "evaluation-result"; evaluationId: number; output: string }
  | {
      type: "evaluation-error";
      evaluationId: number;
      error: SerializedError;
    }
  | {
      type: "sky-call";
      evaluationId: number;
      callId: number;
      method: SkyMethod;
      args: unknown[];
    }
  | {
      type: "browser-call";
      evaluationId: number;
      callId: number;
      method: BrowserMethod;
      args: unknown[];
    };
