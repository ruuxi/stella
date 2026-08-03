import path from "node:path";

import type { ToolContext } from "./types.js";

const MAX_SKILL_READ_CACHE_ENTRIES = 200;

type SkillReadEntry = {
  scopeId: string;
  conversationId: string;
  agentId?: string;
  filePath: string;
  signature: string;
};

const servedSkillReads = new Map<string, SkillReadEntry>();

const resolveScope = (
  context?: ToolContext,
): Pick<SkillReadEntry, "scopeId" | "conversationId" | "agentId"> | null => {
  if (!context?.conversationId) return null;
  const agentId = context.agentId?.trim() || undefined;
  return {
    scopeId:
      agentId ??
      `${context.conversationId}:${context.agentType?.trim() || "unknown"}`,
    conversationId: context.conversationId,
    ...(agentId ? { agentId } : {}),
  };
};

const cacheKey = (scopeId: string, filePath: string) =>
  `${scopeId}\u0000${filePath}`;

export const isSkillInstructionPath = (filePath: string): boolean =>
  path.basename(filePath).toLowerCase() === "skill.md";

export const getSkillReadDedupStub = (args: {
  filePath: string;
  signature: string;
  context?: ToolContext;
}): string | null => {
  if (!isSkillInstructionPath(args.filePath)) return null;
  const scope = resolveScope(args.context);
  if (!scope) return null;
  const key = cacheKey(scope.scopeId, args.filePath);
  const cached = servedSkillReads.get(key);
  if (!cached) return null;
  if (cached.signature !== args.signature) {
    servedSkillReads.delete(key);
    return null;
  }
  return `Skill content unchanged since it was loaded earlier in this active context: ${args.filePath}. Use the earlier full Read result.`;
};

export const recordFullSkillRead = (args: {
  filePath: string;
  signature: string;
  context?: ToolContext;
}): void => {
  if (!isSkillInstructionPath(args.filePath)) return;
  const scope = resolveScope(args.context);
  if (!scope) return;
  const key = cacheKey(scope.scopeId, args.filePath);
  servedSkillReads.delete(key);
  servedSkillReads.set(key, {
    ...scope,
    filePath: args.filePath,
    signature: args.signature,
  });
  while (servedSkillReads.size > MAX_SKILL_READ_CACHE_ENTRIES) {
    const oldest = servedSkillReads.keys().next().value as string | undefined;
    if (!oldest) break;
    servedSkillReads.delete(oldest);
  }
};

export const resetSkillReadDedup = (threadKey?: string): void => {
  if (!threadKey) {
    servedSkillReads.clear();
    return;
  }
  for (const [key, entry] of servedSkillReads) {
    if (
      entry.scopeId === threadKey ||
      entry.agentId === threadKey ||
      entry.conversationId === threadKey
    ) {
      servedSkillReads.delete(key);
    }
  }
};
