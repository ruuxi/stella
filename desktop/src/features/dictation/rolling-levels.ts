export const appendRollingLevel = (
  levels: readonly number[],
  level: number,
  maxLevels: number,
): number[] => {
  if (levels.length < maxLevels) {
    return [...levels, level];
  }
  const next = levels.slice(levels.length - maxLevels + 1);
  next.push(level);
  return next;
};
