export const asObjectRecord = <T = unknown>(value: unknown): Record<string, T> =>
  value && typeof value === "object" ? (value as Record<string, T>) : {};
