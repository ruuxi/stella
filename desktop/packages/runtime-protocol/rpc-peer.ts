import { EventEmitter } from "node:events";
import {
  RPC_ERROR_CODES,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from "./index.js";

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown) => Promise<void> | void;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export const createRuntimeUnavailableError = (
  message = "Runtime is not available.",
  data?: unknown,
) => new RpcError(RPC_ERROR_CODES.RUNTIME_UNAVAILABLE, message, data);

export const isRuntimeUnavailableError = (error: unknown): error is RpcError =>
  error instanceof RpcError && error.code === RPC_ERROR_CODES.RUNTIME_UNAVAILABLE;

export class JsonRpcPeer {
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: any) => void;
      reject: (reason?: any) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private nextId = 1;
  private readonly events = new EventEmitter();

  constructor(
    private readonly sendMessage: (message: JsonRpcMessage) => void,
    private readonly options: {
      requestTimeoutMs?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  on(eventName: "closed", listener: () => void): () => void {
    this.events.on(eventName, listener);
    return () => {
      this.events.removeListener(eventName, listener);
    };
  }

  dispose() {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new RpcError(RPC_ERROR_CODES.INTERNAL_ERROR, "RPC peer disposed."));
    }
    this.pending.clear();
    this.events.emit("closed");
  }

  registerRequestHandler(method: string, handler: RequestHandler) {
    this.requestHandlers.set(method, handler);
  }

  registerNotificationHandler(method: string, handler: NotificationHandler) {
    this.notificationHandlers.set(method, handler);
  }

  notify(method: string, params?: unknown) {
    const message: JsonRpcNotification = { method, ...(params === undefined ? {} : { params }) };
    this.sendMessage(message);
  }

  request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    const id = this.nextId++;
    const timeoutMs = this.options.requestTimeoutMs ?? 30 * 60 * 1000;
    const message: JsonRpcRequest = { id, method, ...(params === undefined ? {} : { params }) };
    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(RPC_ERROR_CODES.INTERNAL_ERROR, `RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.sendMessage(message);
    });
  }

  async handleMessage(message: JsonRpcMessage) {
    if ("method" in message) {
      if ("id" in message) {
        await this.handleRequest(message);
        return;
      }
      await this.handleNotification(message);
      return;
    }

    if ("result" in message) {
      this.handleSuccess(message);
      return;
    }

    this.handleFailure(message);
  }

  private async handleRequest(message: JsonRpcRequest) {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.sendMessage({
        id: message.id,
        error: {
          code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
          message: `Unknown method: ${message.method}`,
        },
      } satisfies JsonRpcFailure);
      return;
    }

    try {
      const result = await handler(message.params);
      this.sendMessage({
        id: message.id,
        result,
      } satisfies JsonRpcSuccess);
    } catch (error) {
      const rpcError =
        error instanceof RpcError
          ? error
          : new RpcError(
              RPC_ERROR_CODES.INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
            );
      this.sendMessage({
        id: message.id,
        error: {
          code: rpcError.code,
          message: rpcError.message,
          ...(rpcError.data === undefined ? {} : { data: rpcError.data }),
        },
      } satisfies JsonRpcFailure);
      this.options.onError?.(error);
    }
  }

  private async handleNotification(message: JsonRpcNotification) {
    const handler = this.notificationHandlers.get(message.method);
    if (!handler) {
      return;
    }
    try {
      await handler(message.params);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private handleSuccess(message: JsonRpcSuccess) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    pending.resolve(message.result);
  }

  private handleFailure(message: JsonRpcFailure) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    pending.reject(
      new RpcError(message.error.code, message.error.message, message.error.data),
    );
  }
}
