/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/api";
import { getOrCreateDeviceId } from "../../services/device";
import type {
  ScreenCommandHandler,
  ScreenDefinition,
  ScreenDescriptor,
  ScreenInvokeResult,
} from "./screen-types";

const INVOKE_TIMEOUT_MS = 20_000;

type PendingInvoke = {
  screenId: string;
  command: string;
  args: Record<string, unknown>;
  requestId?: string;
  conversationId?: string | null;
  deviceId?: string | null;
  resolve: (value: ScreenInvokeResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ScreenEvent = {
  screenId: string;
  eventName: string;
  payload: Record<string, unknown>;
  timestamp: number;
};

type ScreenCommandBus = {
  screens: ScreenDefinition[];
  listScreens: () => ScreenDescriptor[];
  getScreen: (screenId: string) => ScreenDefinition | null;
  registerCommand: (
    screenId: string,
    command: string,
    handler: ScreenCommandHandler,
  ) => () => void;
  invoke: (
    screenId: string,
    command: string,
    args?: Record<string, unknown>,
    meta?: {
      requestId?: string;
      conversationId?: string | null;
      deviceId?: string | null;
    },
  ) => Promise<ScreenInvokeResult>;
  emitEvent: (screenId: string, eventName: string, payload?: Record<string, unknown>) => void;
  subscribe: (screenId: string, handler: (event: ScreenEvent) => void) => () => void;
};

const ScreenCommandBusContext = createContext<ScreenCommandBus | null>(null);

const toDescriptor = (screen: ScreenDefinition): ScreenDescriptor => {
  const commands = screen.commands
    ? Object.entries(screen.commands).map(([name, descriptor]) => ({
        name,
        description: descriptor.description,
        schema: descriptor.schema,
      }))
    : [];
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: screen.id,
    title: screen.title,
    description: screen.description,
    commands,
  };
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Screen command failed.";

export const ScreenCommandBusProvider = (props: {
  screens: ScreenDefinition[];
  conversationId: string | null;
  ensureActive: (screenId: string) => void;
  children: ReactNode;
}) => {
  const { screens, conversationId, ensureActive, children } = props;
  const appendEvent = useMutation(api.events.appendEvent);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const handlerMapRef = useRef(
    new Map<string, Map<string, ScreenCommandHandler>>(),
  );
  const pendingRef = useRef(new Map<string, PendingInvoke[]>());
  const subscriberRef = useRef(new Map<string, Set<(event: ScreenEvent) => void>>());

  useEffect(() => {
    let cancelled = false;
    void getOrCreateDeviceId()
      .then((id) => {
        if (!cancelled) {
          setDeviceId(id);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDeviceId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const getScreen = useCallback(
    (screenId: string) => screens.find((screen) => screen.id === screenId) ?? null,
    [screens],
  );

  const dispatchToHandler = useCallback(
    async (
      screenId: string,
      command: string,
      args: Record<string, unknown>,
      meta?: {
        requestId?: string;
        conversationId?: string | null;
        deviceId?: string | null;
      },
    ): Promise<ScreenInvokeResult | null> => {
      const commands = handlerMapRef.current.get(screenId);
      const handler = commands?.get(command);
      if (!handler) {
        return null;
      }

      try {
        const result = await handler(args, {
          screenId,
          command,
          requestId: meta?.requestId,
          conversationId: meta?.conversationId ?? conversationId,
          deviceId: meta?.deviceId ?? deviceId,
        });
        return {
          requestId: meta?.requestId ?? "",
          ok: true,
          result,
        };
      } catch (error) {
        return {
          requestId: meta?.requestId ?? "",
          ok: false,
          error: getErrorMessage(error),
        };
      }
    },
    [conversationId, deviceId],
  );

  const drainPending = useCallback(
    async (screenId: string, command: string, handler: ScreenCommandHandler) => {
      const queue = pendingRef.current.get(screenId);
      if (!queue || queue.length === 0) {
        return;
      }

      const remaining: PendingInvoke[] = [];
      for (const pending of queue) {
        if (pending.command !== command) {
          remaining.push(pending);
          continue;
        }

        clearTimeout(pending.timeout);
        try {
          const result = await handler(pending.args, {
            screenId,
            command,
            requestId: pending.requestId,
            conversationId: pending.conversationId ?? conversationId,
            deviceId: pending.deviceId ?? deviceId,
          });
          pending.resolve({
            requestId: pending.requestId ?? "",
            ok: true,
            result,
          });
        } catch (error) {
          pending.resolve({
            requestId: pending.requestId ?? "",
            ok: false,
            error: getErrorMessage(error),
          });
        }
      }

      if (remaining.length > 0) {
        pendingRef.current.set(screenId, remaining);
      } else {
        pendingRef.current.delete(screenId);
      }
    },
    [conversationId, deviceId],
  );

  const registerCommand = useCallback(
    (screenId: string, command: string, handler: ScreenCommandHandler) => {
      let commands = handlerMapRef.current.get(screenId);
      if (!commands) {
        commands = new Map<string, ScreenCommandHandler>();
        handlerMapRef.current.set(screenId, commands);
      }
      commands.set(command, handler);
      void drainPending(screenId, command, handler);

      return () => {
        const current = handlerMapRef.current.get(screenId);
        if (!current) {
          return;
        }
        const existing = current.get(command);
        if (existing === handler) {
          current.delete(command);
        }
        if (current.size === 0) {
          handlerMapRef.current.delete(screenId);
        }
      };
    },
    [drainPending],
  );

  const invoke = useCallback(
    async (
      screenId: string,
      command: string,
      args?: Record<string, unknown>,
      meta?: {
        requestId?: string;
        conversationId?: string | null;
        deviceId?: string | null;
      },
    ): Promise<ScreenInvokeResult> => {
      const screen = getScreen(screenId);
      if (!screen) {
        return {
          requestId: meta?.requestId ?? "",
          ok: false,
          error: `Unknown screen: ${screenId}`,
        };
      }

      ensureActive(screenId);

      const safeArgs = args ?? {};
      const immediate = await dispatchToHandler(screenId, command, safeArgs, meta);
      if (immediate) {
        return immediate;
      }

      return await new Promise<ScreenInvokeResult>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({
            requestId: meta?.requestId ?? "",
            ok: false,
            error: `Screen command timed out waiting for handler: ${screenId}.${command}`,
          });
        }, INVOKE_TIMEOUT_MS);

        const pending: PendingInvoke = {
          screenId,
          command,
          args: safeArgs,
          requestId: meta?.requestId,
          conversationId: meta?.conversationId ?? conversationId,
          deviceId: meta?.deviceId ?? deviceId,
          resolve,
          timeout,
        };

        const queue = pendingRef.current.get(screenId) ?? [];
        pendingRef.current.set(screenId, [...queue, pending]);
      });
    },
    [conversationId, deviceId, dispatchToHandler, ensureActive, getScreen],
  );

  const emitEvent = useCallback(
    (screenId: string, eventName: string, payload?: Record<string, unknown>) => {
      const event: ScreenEvent = {
        screenId,
        eventName,
        payload: payload ?? {},
        timestamp: Date.now(),
      };

      const subscribers = subscriberRef.current.get(screenId);
      if (subscribers) {
        for (const handler of subscribers) {
          handler(event);
        }
      }

      if (!conversationId || !deviceId) {
        return;
      }

      void appendEvent({
        conversationId,
        type: "screen_event",
        deviceId,
        payload: {
          screenId,
          eventName,
          payload: event.payload,
          timestamp: event.timestamp,
        },
      });
    },
    [appendEvent, conversationId, deviceId],
  );

  const subscribe = useCallback((screenId: string, handler: (event: ScreenEvent) => void) => {
    const existing = subscriberRef.current.get(screenId) ?? new Set<(event: ScreenEvent) => void>();
    existing.add(handler);
    subscriberRef.current.set(screenId, existing);
    return () => {
      const current = subscriberRef.current.get(screenId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        subscriberRef.current.delete(screenId);
      }
    };
  }, []);

  const value = useMemo<ScreenCommandBus>(
    () => ({
      screens,
      listScreens: () => screens.map((screen) => toDescriptor(screen)),
      getScreen,
      registerCommand,
      invoke,
      emitEvent,
      subscribe,
    }),
    [emitEvent, getScreen, invoke, registerCommand, screens, subscribe],
  );

  return (
    <ScreenCommandBusContext.Provider value={value}>
      {children}
    </ScreenCommandBusContext.Provider>
  );
};

export const useScreenCommandBus = () => {
  const context = useContext(ScreenCommandBusContext);
  if (!context) {
    throw new Error("useScreenCommandBus must be used within ScreenCommandBusProvider.");
  }
  return context;
};

export const useScreenRuntime = (screenId: string) => {
  const bus = useScreenCommandBus();

  const registerCommand = useCallback(
    (command: string, handler: ScreenCommandHandler) =>
      bus.registerCommand(screenId, command, handler),
    [bus, screenId],
  );

  const emitEvent = useCallback(
    (eventName: string, payload?: Record<string, unknown>) =>
      bus.emitEvent(screenId, eventName, payload),
    [bus, screenId],
  );

  return {
    registerCommand,
    emitEvent,
  };
};
