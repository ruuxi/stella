/**
 * The worker initialization response is the host's readiness boundary. Keep
 * this tiny gate shared with tests so a bridge failure can never be converted
 * into a post-ready best-effort task again.
 */
export const afterRequiredCliBridgeReady = async <T>(
  startBridge: () => Promise<void>,
  buildReadyResult: () => T,
): Promise<T> => {
  await startBridge();
  return buildReadyResult();
};

export const connectorActionBrokerAvailability = (
  platform: NodeJS.Platform,
): { supported: true } | { supported: false; reason: string } =>
  platform === "win32"
    ? {
        supported: false,
        reason:
          "Secure connector action brokering is unavailable on Windows until a current-user named-pipe ACL is supported.",
      }
    : { supported: true };
