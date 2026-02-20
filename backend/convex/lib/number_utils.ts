type NormalizeOptionalIntArgs = {
  value: number | null | undefined;
  defaultValue: number;
  min: number;
  max: number;
};

export const clampIntToRange = (value: number, min: number, max: number): number => {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  const normalized = Number.isFinite(value) ? Math.floor(value) : lower;
  return Math.min(Math.max(normalized, lower), upper);
};

export const normalizeOptionalInt = ({
  value,
  defaultValue,
  min,
  max,
}: NormalizeOptionalIntArgs): number => {
  const fallback = Number.isFinite(defaultValue) ? defaultValue : min;
  const input = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clampIntToRange(input, min, max);
};
