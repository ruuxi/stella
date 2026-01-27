import { ipcMain } from "electron";

type PendingResolver<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ScreenInvokeRequest = {
  requestId: string;
  screenId: string;
  command: string;
  args?: Record<string, unknown>;
  conversationId: string;
  deviceId: string;
};

type ScreenInvokeResult = {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type ScreenListRequest = {
  requestId: string;
  conversationId: string;
  deviceId: string;
};

type ScreenListResult = {
  requestId: string;
  ok: boolean;
  screens?: unknown[];
  error?: string;
};

export const createScreenBridge = (options: {
  getTargetWindow: () => { webContents: { send: (channel: string, payload: unknown) => void } } | null;
  invokeTimeoutMs?: number;
}) => {
  const invokeTimeoutMs = Math.max(5_000, Math.floor(options.invokeTimeoutMs ?? 30_000));
  const pendingInvoke = new Map<string, PendingResolver<ScreenInvokeResult>>();
  const pendingList = new Map<string, PendingResolver<ScreenListResult>>();

  const resolvePending = <T extends { requestId: string }>(
    map: Map<string, PendingResolver<T>>,
    payload: T,
  ) => {
    const pending = map.get(payload.requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timeout);
    map.delete(payload.requestId);
    pending.resolve(payload);
    return true;
  };

  ipcMain.on("screen:result", (_event, payload: ScreenInvokeResult) => {
    resolvePending(pendingInvoke, payload);
  });

  ipcMain.on("screen:list-result", (_event, payload: ScreenListResult) => {
    resolvePending(pendingList, payload);
  });

  const invokeScreenCommand = async (input: {
    screenId: string;
    command: string;
    args?: Record<string, unknown>;
    requestId?: string;
    conversationId: string;
    deviceId: string;
  }) => {
    const target = options.getTargetWindow();
    if (!target) {
      return { ok: false, error: "No target window available for screen commands." };
    }

    const requestId = input.requestId?.trim() || crypto.randomUUID();
    const request: ScreenInvokeRequest = {
      requestId,
      screenId: input.screenId,
      command: input.command,
      args: input.args ?? {},
      conversationId: input.conversationId,
      deviceId: input.deviceId,
    };

    const resultPromise = new Promise<ScreenInvokeResult>((resolve, reject) => {
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
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  };

  const listScreens = async (input: { conversationId: string; deviceId: string }) => {
    const target = options.getTargetWindow();
    if (!target) {
      return { ok: false, error: "No target window available for listing screens." };
    }

    const requestId = crypto.randomUUID();
    const request: ScreenListRequest = {
      requestId,
      conversationId: input.conversationId,
      deviceId: input.deviceId,
    };

    const resultPromise = new Promise<ScreenListResult>((resolve, reject) => {
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
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  };

  return {
    invokeScreenCommand,
    listScreens,
  };
};

export type ScreenBridge = ReturnType<typeof createScreenBridge>;

