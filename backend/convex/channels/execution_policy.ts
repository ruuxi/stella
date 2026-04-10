export const MOBILE_APP_PROVIDER = "stella_app" as const;

export const EXECUTION_NOT_AVAILABLE_MESSAGE =
  "Your desktop is offline right now. Open Stella on your desktop and try again.";

export const shouldUseOfflineResponderForProvider = (
  provider: string,
): boolean => provider === MOBILE_APP_PROVIDER;
