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
    ?.VITE_SPACETIMEDB_MODULE ?? "{{spacetimedbModule}}";

const SPACETIMEDB_TOKEN_KEY = "spacetimedb_token";
const CONVEX_TOKEN_KEY = "stella_game_convex_token";
const DISPLAY_NAME_KEY = "stella_game_display_name";

export const getSavedToken = (): string | undefined => {
  try {
    return localStorage.getItem(SPACETIMEDB_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const saveToken = (token: string): void => {
  try {
    localStorage.setItem(SPACETIMEDB_TOKEN_KEY, token);
  } catch {
    // localStorage may not be available
  }
};

export const getSavedConvexToken = (): string | undefined => {
  try {
    return localStorage.getItem(CONVEX_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const saveConvexToken = (token: string): void => {
  try {
    localStorage.setItem(CONVEX_TOKEN_KEY, token);
  } catch {
    // localStorage may not be available
  }
};

export const getSavedDisplayName = (): string | undefined => {
  try {
    return localStorage.getItem(DISPLAY_NAME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const saveDisplayName = (displayName: string): void => {
  try {
    localStorage.setItem(DISPLAY_NAME_KEY, displayName);
  } catch {
    // localStorage may not be available
  }
};
