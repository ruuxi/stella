import type { ActivityItem } from "./schedule-item";

type ActivityOrderKey = {
  distanceMs: number;
  sourcePriority: 0 | 1;
  sourceTimeMs: number;
};

const isFiniteTime = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

function getActivityOrderKey(
  item: ActivityItem,
  now: number,
): ActivityOrderKey | null {
  const candidates: ActivityOrderKey[] = [];

  if (item.kind !== "task" && isFiniteTime(item.nextRunAtMs)) {
    candidates.push({
      distanceMs: Math.abs(item.nextRunAtMs - now),
      sourcePriority: 0,
      sourceTimeMs: item.nextRunAtMs,
    });
  }

  if (isFiniteTime(item.lastRunAtMs)) {
    candidates.push({
      distanceMs: Math.abs(item.lastRunAtMs - now),
      sourcePriority: 1,
      sourceTimeMs: item.lastRunAtMs,
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    if (a.distanceMs !== b.distanceMs) {
      return a.distanceMs - b.distanceMs;
    }
    if (a.sourcePriority !== b.sourcePriority) {
      return a.sourcePriority - b.sourcePriority;
    }
    if (a.sourcePriority === 0) {
      return a.sourceTimeMs - b.sourceTimeMs;
    }
    return b.sourceTimeMs - a.sourceTimeMs;
  });

  return candidates[0] ?? null;
}

export function compareActivityItems(
  a: ActivityItem,
  b: ActivityItem,
  now = Date.now(),
): number {
  const aKey = getActivityOrderKey(a, now);
  const bKey = getActivityOrderKey(b, now);

  if (!aKey && !bKey) {
    return a.name.localeCompare(b.name);
  }
  if (!aKey) {
    return 1;
  }
  if (!bKey) {
    return -1;
  }

  if (aKey.distanceMs !== bKey.distanceMs) {
    return aKey.distanceMs - bKey.distanceMs;
  }
  if (aKey.sourcePriority !== bKey.sourcePriority) {
    return aKey.sourcePriority - bKey.sourcePriority;
  }
  if (aKey.sourcePriority === 0 && aKey.sourceTimeMs !== bKey.sourceTimeMs) {
    return aKey.sourceTimeMs - bKey.sourceTimeMs;
  }
  if (aKey.sourcePriority === 1 && aKey.sourceTimeMs !== bKey.sourceTimeMs) {
    return bKey.sourceTimeMs - aKey.sourceTimeMs;
  }
  return a.name.localeCompare(b.name);
}

export function sortActivityItems(
  items: ActivityItem[],
  now = Date.now(),
): ActivityItem[] {
  return items.toSorted((a, b) => compareActivityItems(a, b, now));
}
