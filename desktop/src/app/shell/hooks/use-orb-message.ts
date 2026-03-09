import { useState, useEffect, useRef } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";

const STORAGE_KEY = "stella:orb-last-seen-message";

/**
 * Extracts the latest assistant message from events and manages
 * a show → read → hide lifecycle for the floating orb bubble.
 *
 * Returns only `text`; entrance/exit animations are handled by motion
 * in the FloatingOrb component (AnimatePresence).
 */
export function useOrbMessage(
  events: EventRecord[],
  isVisible: boolean,
): { text: string | null } {
  const [text, setText] = useState<string | null>(null);
  const [storedId] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  });
  const lastSeenIdRef = useRef<string | null>(storedId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isVisible) {
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    // Find the latest assistant_message event
    let latest: EventRecord | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "assistant_message") {
        latest = events[i];
        break;
      }
    }

    if (!latest || latest._id === lastSeenIdRef.current) return;
    lastSeenIdRef.current = latest._id;
    try { localStorage.setItem(STORAGE_KEY, latest._id); } catch { /* noop */ }

    const rawText = (latest.payload as { text?: string })?.text ?? "";
    if (!rawText.trim()) return;

    // Truncate for display
    const displayText = rawText.length > 150
      ? rawText.slice(0, 147) + "..."
      : rawText;

    queueMicrotask(() => {
      setText(displayText);
    });

    // Clear previous timer
    if (timerRef.current) clearTimeout(timerRef.current);

    // Calculate reading time: ~60ms per word, minimum 3s
    const wordCount = displayText.split(/\s+/).length;
    const readingTime = Math.max(3000, wordCount * 60);

    // Hide after reading time — exit animation handled by motion
    timerRef.current = setTimeout(() => {
      setText(null);
    }, readingTime);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [events, isVisible]);

  return isVisible ? { text } : { text: null };
}
