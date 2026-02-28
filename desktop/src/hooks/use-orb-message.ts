import { useState, useEffect, useRef } from "react";
import type { EventRecord } from "./use-conversation-events";

const STORAGE_KEY = "stella:orb-last-seen-message";

/**
 * Extracts the latest assistant message from events and manages
 * a show/fade/hide lifecycle for the floating orb bubble.
 */
export function useOrbMessage(
  events: EventRecord[],
  isVisible: boolean,
): { text: string | null; opacity: number } {
  const [text, setText] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(0);
  const [storedId] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  });
  const lastSeenIdRef = useRef<string | null>(storedId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isVisible) {
      setText(null);
      setOpacity(0);
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

    setText(displayText);
    setOpacity(1);

    // Clear previous timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);

    // Calculate reading time: ~60ms per word, minimum 3s
    const wordCount = displayText.split(/\s+/).length;
    const readingTime = Math.max(3000, wordCount * 60);

    // Start fade after reading time
    timerRef.current = setTimeout(() => {
      setOpacity(0);
      // Hide text after fade completes
      fadeTimerRef.current = setTimeout(() => {
        setText(null);
      }, 1000);
    }, readingTime);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [events, isVisible]);

  return { text, opacity };
}
