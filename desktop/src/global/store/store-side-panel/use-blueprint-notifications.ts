import { useEffect, useRef } from "react";
import { deriveBlueprintName, fireBlueprintNotification } from "./format";
import type { StoreThreadMessage } from "./types";

/**
 * Surface an OS notification when a brand-new blueprint draft arrives
 * (one we've never observed in this session). Seeds the "seen" set on
 * first load so existing drafts don't re-fire on mount.
 *
 * The seen-set still earns its keep even after the live subscription
 * replaced polling: every thread mutation re-emits the full snapshot,
 * so without dedupe we'd notify on every patch (e.g. pending → done).
 */
export function useBlueprintNotifications(
  messages: StoreThreadMessage[],
): void {
  const seenBlueprintsRef = useRef<Set<string>>(new Set());
  const hasSeededBlueprintsRef = useRef(false);

  useEffect(() => {
    const blueprints = messages.filter(
      (msg) => msg.role === "assistant" && msg.isBlueprint && !msg.denied,
    );
    if (!hasSeededBlueprintsRef.current) {
      hasSeededBlueprintsRef.current = true;
      seenBlueprintsRef.current = new Set(blueprints.map((msg) => msg._id));
      return;
    }
    for (const msg of blueprints) {
      if (seenBlueprintsRef.current.has(msg._id)) continue;
      seenBlueprintsRef.current.add(msg._id);
      fireBlueprintNotification(msg._id, deriveBlueprintName(msg.text));
    }
  }, [messages]);
}
