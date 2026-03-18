export const normalizeToolCallId = (value: string): string => {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
};
