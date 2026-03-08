export const asObjectRecord = <T = unknown>(value: unknown): Record<string, T> =>
  value && typeof value === "object" ? (value as Record<string, T>) : {};

export const asPlainObjectRecord = <T = unknown>(value: unknown): Record<string, T> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
