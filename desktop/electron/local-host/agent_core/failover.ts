export async function runWithFallbackModel<T>(args: {
  runWithModel: (modelId: string) => Promise<T>;
  primaryModelId: string;
  fallbackModelId?: string;
  shouldFallback: (error: unknown) => boolean;
  onFallback?: (error: unknown, fallbackModelId: string) => Promise<void> | void;
}): Promise<T> {
  try {
    return await args.runWithModel(args.primaryModelId);
  } catch (error) {
    const fallbackModelId = args.fallbackModelId;
    if (!fallbackModelId || !args.shouldFallback(error)) {
      throw error;
    }
    if (args.onFallback) {
      await args.onFallback(error, fallbackModelId);
    }
    return await args.runWithModel(fallbackModelId);
  }
}
