/**
 * SpacetimeDB connection configuration.
 *
 * After deploying the SpacetimeDB module, generate bindings:
 *   spacetime generate --lang typescript --out-dir src/bindings
 *
 * Then import DbConnection and tables from the generated bindings.
 */

export const SPACETIMEDB_HOST =
  (import.meta as Record<string, Record<string, string>>).env
    ?.VITE_SPACETIMEDB_HOST ?? "wss://maincloud.spacetimedb.com";

export const SPACETIMEDB_MODULE =
  (import.meta as Record<string, Record<string, string>>).env
    ?.VITE_SPACETIMEDB_MODULE ?? "stella-w08uu";

const TOKEN_KEY = "spacetimedb_token";

export const getSavedToken = (): string | undefined => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const saveToken = (token: string): void => {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage may not be available
  }
};
