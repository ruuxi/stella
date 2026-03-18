import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "@/ui/dialog";
import {
  type TraceCategory,
  type TraceEntry,
  getTraceEntries,
  subscribeTrace,
  clearTrace,
  formatTraceForClipboard,
} from "@/debug/trace-store";
import "./trace-viewer-dialog.css";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const ALL_CATEGORIES: TraceCategory[] = [
  "orchestrator",
  "agent",
  "tool",
  "voice",
  "system",
  "error",
];

function formatTs(ts: number): string {
  const d = new Date(ts);
  return (
    d.toTimeString().slice(0, 8) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function formatTraceData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function TraceEntryRow({ entry }: { entry: TraceEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="trace-entry"
      data-cat={entry.cat}
      data-expanded={expanded || undefined}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="trace-entry-header">
        <span className="trace-ts">{formatTs(entry.ts)}</span>
        <span className="trace-badge" data-cat={entry.cat}>
          {entry.cat}
        </span>
        {entry.agent && (
          <span className="trace-agent-badge">{entry.agent}</span>
        )}
        <span className="trace-event-name">{entry.event}</span>
        {entry.duration != null && (
          <span className="trace-duration">{entry.duration}ms</span>
        )}
        <span className="trace-summary">{entry.summary}</span>
      </div>
      {expanded && entry.data != null && (
        <div className="trace-entry-data">
          {formatTraceData(entry.data)}
        </div>
      )}
    </div>
  );
}

export default function TraceViewerDialog({ open, onOpenChange }: Props) {
  const entries = useSyncExternalStore(subscribeTrace, getTraceEntries, getTraceEntries);

  const [activeFilters, setActiveFilters] = useState<Set<TraceCategory>>(
    () => new Set(ALL_CATEGORIES),
  );
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(entries.length);

  const toggleFilter = useCallback((cat: TraceCategory) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  }, []);

  const filteredEntries = entries.filter((e) => activeFilters.has(e.cat));

  // Auto-scroll to bottom when new entries arrive
  useLayoutEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    if (entries.length > prevLenRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = entries.length;
  }, [entries.length, autoScroll, filteredEntries.length]);

  // Also scroll on open
  useEffect(() => {
    if (open && autoScroll && scrollRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [open, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const nearBottom = scrollHeight - scrollTop - clientHeight < 60;
    setAutoScroll(nearBottom);
  }, []);

  const handleCopy = useCallback(() => {
    const text = formatTraceForClipboard(filteredEntries);
    void navigator.clipboard.writeText(text);
  }, [filteredEntries]);

  const handleClear = useCallback(() => {
    clearTrace();
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setAutoScroll(true);
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="xl" className="trace-viewer-content">
        <Dialog.Header>
          <Dialog.Title>Agent Trace</Dialog.Title>
          <Dialog.CloseButton />
        </Dialog.Header>
        <Dialog.Body>
          <div className="trace-viewer-body">
            <div className="trace-toolbar">
              <div className="trace-toolbar-group">
                {ALL_CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    className="trace-filter-btn"
                    data-active={activeFilters.has(cat)}
                    onClick={() => toggleFilter(cat)}
                  >
                    {cat}
                  </button>
                ))}
              </div>
              <span className="trace-count">
                {filteredEntries.length}/{entries.length}
              </span>
              <div className="trace-toolbar-spacer" />
              <button className="trace-action-btn" onClick={handleCopy}>
                Copy
              </button>
              <button
                className="trace-action-btn"
                data-variant="danger"
                onClick={handleClear}
              >
                Clear
              </button>
            </div>

            <div
              className="trace-entries"
              ref={scrollRef}
              onScroll={handleScroll}
            >
              {filteredEntries.length === 0 ? (
                <div className="trace-empty">
                  {entries.length === 0
                    ? "No trace entries yet. Send a message to start capturing."
                    : "No entries match the active filters."}
                </div>
              ) : (
                filteredEntries.map((entry) => (
                  <TraceEntryRow key={entry.id} entry={entry} />
                ))
              )}
            </div>

            {!autoScroll && filteredEntries.length > 0 && (
              <div className="trace-autoscroll-indicator">
                <button
                  className="trace-autoscroll-btn"
                  onClick={scrollToBottom}
                >
                  Scroll to latest
                </button>
              </div>
            )}
          </div>
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  );
}
