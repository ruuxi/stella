import { ActionCtx } from "../_generated/server";
import { resolveModelConfig, resolveFallbackConfig } from "./model_resolver";
import { streamTextWithFailover, generateTextWithFailover } from "./model_execution";

export type ExecutionArgs = {
  ctx: ActionCtx;
  agentType: string;
  ownerId?: string;
  sharedArgs: Record<string, unknown>;
  useFailover?: boolean;
};

export const executeStream = async ({ ctx, agentType, ownerId, sharedArgs, useFailover = true }: ExecutionArgs) => {
  const resolvedConfig = await resolveModelConfig(ctx, agentType, ownerId);
  const fallbackConfig = useFailover 
    ? await resolveFallbackConfig(ctx, agentType, ownerId).catch(() => null) 
    : null;
  
  return streamTextWithFailover({
    resolvedConfig,
    fallbackConfig: fallbackConfig ?? undefined,
    sharedArgs,
  });
};

export const executeGenerate = async ({ ctx, agentType, ownerId, sharedArgs, useFailover = true }: ExecutionArgs) => {
  const resolvedConfig = await resolveModelConfig(ctx, agentType, ownerId);
  const fallbackConfig = useFailover 
    ? await resolveFallbackConfig(ctx, agentType, ownerId).catch(() => null) 
    : null;
  
  return generateTextWithFailover({
    resolvedConfig,
    fallbackConfig: fallbackConfig ?? undefined,
    sharedArgs,
  });
};
