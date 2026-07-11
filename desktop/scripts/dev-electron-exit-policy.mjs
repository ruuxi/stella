/**
 * Decide what the dev supervisor can do immediately when Electron exits.
 *
 * A clean exit is a deliberate app quit unless an explicit relaunch marker
 * already exists. Deferred watcher work must not outrank that user intent;
 * startup freshness checks will rebuild anything stale on the next launch.
 */
export const classifyElectronExit = ({
  code,
  signal,
  explicitRestartRequested,
  watcherRestartRequested,
}) => {
  if (explicitRestartRequested) return "restart";
  if ((code ?? 0) === 0 && !signal) return "wait-then-stop";
  if (watcherRestartRequested) return "restart";
  return "wait-then-stop";
};
