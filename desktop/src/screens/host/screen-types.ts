import type { ComponentType } from "react";

export type ScreenCommandHandler = (
  args: Record<string, unknown>,
  context: {
    screenId: string;
    command: string;
    requestId?: string;
    conversationId?: string | null;
    deviceId?: string | null;
  },
) => Promise<unknown> | unknown;

export type ScreenCommandDescriptor = {
  description?: string;
  schema?: Record<string, unknown>;
};

export type ScreenDefinition = {
  id: string;
  title: string;
  description?: string;
  component: ComponentType<{
    screenId: string;
    active: boolean;
  }>;
  commands?: Record<string, ScreenCommandDescriptor>;
};

export type ScreenDescriptor = {
  id: string;
  title: string;
  description?: string;
  commands: Array<{
    name: string;
    description?: string;
    schema?: Record<string, unknown>;
  }>;
};

export type ScreenInvokeRequest = {
  requestId: string;
  screenId: string;
  command: string;
  args?: Record<string, unknown>;
  conversationId: string;
  deviceId: string;
};

export type ScreenInvokeResult = {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type ScreenListRequest = {
  requestId: string;
  conversationId: string;
  deviceId: string;
};

export type ScreenListResult = {
  requestId: string;
  ok: boolean;
  screens?: ScreenDescriptor[];
  error?: string;
};

