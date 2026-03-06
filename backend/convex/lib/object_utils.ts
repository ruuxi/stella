export const asPlainObjectRecord = <T = unknown>(value: unknown): Record<string, T> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
