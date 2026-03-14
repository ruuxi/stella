const DEFAULT_SPACETIMEDB_URI = "wss://maincloud.spacetimedb.com";
const DEFAULT_SPACETIMEDB_DATABASE = "stella-w08uu";
const SPACETIMEDB_TOKEN_KEY = "stella:games:spacetimedb-token";

export const SPACETIMEDB_URI =
  import.meta.env.VITE_SPACETIMEDB_HOST ?? DEFAULT_SPACETIMEDB_URI;

export const SPACETIMEDB_DATABASE =
  import.meta.env.VITE_SPACETIMEDB_MODULE ?? DEFAULT_SPACETIMEDB_DATABASE;

export function getSavedSpacetimeToken(): string | undefined {
  try {
    return localStorage.getItem(SPACETIMEDB_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveSpacetimeToken(token: string): void {
  try {
    localStorage.setItem(SPACETIMEDB_TOKEN_KEY, token);
  } catch {
    // localStorage may be unavailable during preload or privacy-restricted flows.
  }
}

export function clearSavedSpacetimeToken(): void {
  try {
    localStorage.removeItem(SPACETIMEDB_TOKEN_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}
