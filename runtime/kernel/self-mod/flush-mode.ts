export type SelfModHmrFlushMode = "none" | "module-reload" | "full-reload";

export const getSelfModHmrFlushMode = (args: {
  queuedModuleCount: number;
  requiresFullReload: boolean;
}): SelfModHmrFlushMode => {
  if (args.requiresFullReload) {
    return "full-reload";
  }

  if (args.queuedModuleCount > 0) {
    return "module-reload";
  }

  return "none";
};

export const shouldRunSelfModHmrTransition = (status?: {
  queuedModules?: number;
  requiresFullReload?: boolean;
} | null): boolean =>
  getSelfModHmrFlushMode({
    queuedModuleCount: Number(status?.queuedModules ?? 0),
    requiresFullReload: Boolean(status?.requiresFullReload),
  }) !== "none";
