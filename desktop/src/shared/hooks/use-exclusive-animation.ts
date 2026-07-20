import { useEffect, useId, useSyncExternalStore } from "react";

type AnimationCandidate = { id: string; order: number };

const candidatesByGroup = new Map<string, Map<string, AnimationCandidate>>();
const listenersByGroup = new Map<string, Set<() => void>>();
let nextOrder = 0;

export const selectExclusiveAnimationOwner = (
  candidates: Iterable<AnimationCandidate>,
): string | null => {
  let owner: AnimationCandidate | null = null;
  for (const candidate of candidates) {
    if (!owner || candidate.order > owner.order) owner = candidate;
  }
  return owner?.id ?? null;
};

const getOwner = (group: string): string | null =>
  selectExclusiveAnimationOwner(candidatesByGroup.get(group)?.values() ?? []);

const emit = (group: string) => {
  for (const listener of listenersByGroup.get(group) ?? []) listener();
};

const register = (group: string, id: string) => {
  const candidates = candidatesByGroup.get(group) ?? new Map();
  candidates.set(id, { id, order: nextOrder++ });
  candidatesByGroup.set(group, candidates);
  emit(group);
  return () => {
    candidates.delete(id);
    if (candidates.size === 0) candidatesByGroup.delete(group);
    emit(group);
  };
};

/** Elect the most recently mounted visible candidate inside a motion group. */
export const useExclusiveAnimation = (
  group: string | undefined,
  candidate: boolean,
): boolean => {
  const id = useId();
  const owner = useSyncExternalStore(
    (listener) => {
      if (!group) return () => {};
      const listeners = listenersByGroup.get(group) ?? new Set();
      listeners.add(listener);
      listenersByGroup.set(group, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenersByGroup.delete(group);
      };
    },
    () => (group ? getOwner(group) : id),
    () => id,
  );

  useEffect(() => {
    if (!group || !candidate) return;
    return register(group, id);
  }, [candidate, group, id]);

  return candidate && (!group || owner === id);
};
