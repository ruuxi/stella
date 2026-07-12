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
