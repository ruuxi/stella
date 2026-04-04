/**
 * Runtime-registered JSON schemas and descriptions for dynamically loaded tools
 * so the PI tool layer can expose accurate definitions.
 */

const descriptions = new Map<string, string>();
const schemas = new Map<string, Record<string, unknown>>();

export const registerDynamicToolMetadata = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): void => {
  descriptions.set(name, description);
  schemas.set(name, parameters);
};

export const getDynamicToolDescription = (
  name: string,
): string | undefined => descriptions.get(name);

export const getDynamicToolSchema = (
  name: string,
): Record<string, unknown> | undefined => schemas.get(name);

export const clearDynamicToolMetadata = (): void => {
  descriptions.clear();
  schemas.clear();
};
