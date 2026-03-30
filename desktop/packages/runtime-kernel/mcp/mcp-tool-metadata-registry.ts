/**
 * Runtime-registered JSON schemas and descriptions for MCP-backed tools so the
 * PI tool layer can expose accurate tool definitions after MCP discovery.
 */

const descriptions = new Map<string, string>();
const schemas = new Map<string, Record<string, unknown>>();

export const registerMcpToolMetadata = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): void => {
  descriptions.set(name, description);
  schemas.set(name, parameters);
};

export const getMcpToolDescription = (name: string): string | undefined =>
  descriptions.get(name);

export const getMcpToolSchema = (
  name: string,
): Record<string, unknown> | undefined => schemas.get(name);

export const clearMcpToolMetadata = (): void => {
  descriptions.clear();
  schemas.clear();
};
