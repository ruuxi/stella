/**
 * Session and join code utilities.
 * Reads session info from URL parameters for the join flow.
 */

export const getSessionFromUrl = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  return params.get("session");
};

export const getJoinCodeFromUrl = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  return params.get("code");
};

export const buildJoinUrl = (baseUrl: string, joinCode: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/games/join?code=${encodeURIComponent(joinCode)}`;
