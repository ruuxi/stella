import type { ActivityItem } from "./schedule-item"

type ActivityOrderKey = {
  distanceMs: number
  sourcePriority: 0 | 1
  sourceTimeMs: number
}

const isFiniteTime = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value)

function getActivityOrderKey(
  item: ActivityItem,
  now: number,
): ActivityOrderKey | null {
  switch (item.kind) {
    case "task":
      return isFiniteTime(item.lastRunAtMs)
        ? {
            distanceMs: Math.abs(item.lastRunAtMs - now),
            sourcePriority: 1,
            sourceTimeMs: item.lastRunAtMs,
          } satisfies ActivityOrderKey
        : null
    case "scheduled":
    case "monitoring": {
      const nextRunAtKey = isFiniteTime(item.nextRunAtMs)
        ? {
            distanceMs: Math.abs(item.nextRunAtMs - now),
            sourcePriority: 0,
            sourceTimeMs: item.nextRunAtMs,
          } satisfies ActivityOrderKey
        : null
      const lastRunAtKey = isFiniteTime(item.lastRunAtMs)
        ? {
            distanceMs: Math.abs(item.lastRunAtMs - now),
            sourcePriority: 1,
            sourceTimeMs: item.lastRunAtMs,
          } satisfies ActivityOrderKey
        : null

      if (!nextRunAtKey) {
        return lastRunAtKey
      }
      if (!lastRunAtKey) {
        return nextRunAtKey
      }

      return nextRunAtKey.distanceMs <= lastRunAtKey.distanceMs
        ? nextRunAtKey
        : lastRunAtKey
    }
    default: {
      const exhaustiveCheck: never = item
      return exhaustiveCheck
    }
  }
}

export function compareActivityItems(
  a: ActivityItem,
  b: ActivityItem,
  now = Date.now(),
): number {
  const aKey = getActivityOrderKey(a, now)
  const bKey = getActivityOrderKey(b, now)

  if (!aKey && !bKey) {
    return a.name.localeCompare(b.name)
  }
  if (!aKey) {
    return 1
  }
  if (!bKey) {
    return -1
  }

  if (aKey.distanceMs !== bKey.distanceMs) {
    return aKey.distanceMs - bKey.distanceMs
  }
  if (aKey.sourcePriority !== bKey.sourcePriority) {
    return aKey.sourcePriority - bKey.sourcePriority
  }
  if (aKey.sourcePriority === 0 && aKey.sourceTimeMs !== bKey.sourceTimeMs) {
    return aKey.sourceTimeMs - bKey.sourceTimeMs
  }
  if (aKey.sourcePriority === 1 && aKey.sourceTimeMs !== bKey.sourceTimeMs) {
    return bKey.sourceTimeMs - aKey.sourceTimeMs
  }
  return a.name.localeCompare(b.name)
}

export function sortActivityItems(
  items: ActivityItem[],
  now = Date.now(),
): ActivityItem[] {
  return items.toSorted((a, b) => compareActivityItems(a, b, now))
}
