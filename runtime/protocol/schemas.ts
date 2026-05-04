import { Type, type Static } from "@sinclair/typebox";

import { STELLA_RUNTIME_PROTOCOL_VERSION } from "./index.js";

export const initializeParamsSchema = Type.Object({
  clientName: Type.String({ minLength: 1 }),
  clientVersion: Type.String({ minLength: 1 }),
  platform: Type.String({ minLength: 1 }),
  protocolVersion: Type.String({ minLength: 1 }),
  isDev: Type.Boolean(),
  stellaRoot: Type.String({ minLength: 1 }),
  stellaWorkspacePath: Type.String({ minLength: 1 }),
});

export const runtimeConfigureParamsSchema = Type.Object({
  convexUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  convexSiteUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  authToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  hasConnectedAccount: Type.Optional(Type.Boolean()),
  cloudSyncEnabled: Type.Optional(Type.Boolean()),
});

export const protocolSchemas = {
  initializeParams: initializeParamsSchema,
  runtimeConfigureParams: runtimeConfigureParamsSchema,
} as const;

export type InitializeParamsSchema = Static<typeof initializeParamsSchema>;
export type RuntimeConfigureParamsSchema = Static<
  typeof runtimeConfigureParamsSchema
>;

export type RuntimeProtocolSchemaExport = {
  version: string;
  schemas: typeof protocolSchemas;
};

export const runtimeProtocolSchema: RuntimeProtocolSchemaExport = {
  version: STELLA_RUNTIME_PROTOCOL_VERSION,
  schemas: protocolSchemas,
};
