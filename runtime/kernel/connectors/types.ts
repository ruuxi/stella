export type ConnectorCommandTransport = "stdio" | "streamable_http";

export type ConnectorCommandConfig = {
  id: string;
  displayName: string;
  description?: string;
  transport: ConnectorCommandTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: {
    type: "oauth" | "api_key" | "none";
    tokenKey?: string;
    headerName?: string;
    scheme?: "bearer" | "basic" | "raw";
    envVar?: string;
    clientId?: string;
    resource?: string;
    scopes?: string[];
  };
};

export type ApiConnectorConfig = {
  id: string;
  displayName: string;
  description?: string;
  baseUrl: string;
  auth?: {
    type: "api_key" | "oauth" | "none";
    tokenKey?: string;
    headerName?: string;
    scheme?: "bearer" | "basic" | "raw";
    clientId?: string;
    resource?: string;
    scopes?: string[];
  };
};

export type ConnectorToolInfo = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type ConnectorToolCallResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
