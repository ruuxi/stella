import { useEffect, useRef, useState } from "react";
import { useDevToolSocket, type DevEvent } from "./use-devtool-socket";

type AgentEventPayload = {
  type: string;
  runId?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  chunk?: string;
  taskId?: string;
  agentType?: string;
  description?: string;
  statusText?: string;
};

type EventFilter = "all" | "agent-event" | "app-lifecycle" | "log";

const EVENT_FILTERS: { value: EventFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "agent-event", label: "Agent" },
  { value: "app-lifecycle", label: "Lifecycle" },
  { value: "log", label: "Log" },
];

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function getEventLabel(event: DevEvent): string {
  if (event.type === "agent-event") {
    const p = event.payload as AgentEventPayload;
    if (p.toolName) return `${p.type} — ${p.toolName}`;
    if (p.agentType) return `${p.type} — ${p.agentType}`;
    return p.type;
  }
  if (event.type === "app-lifecycle") {
    return (event.payload as { action: string }).action;
  }
  return event.type;
}

function getEventDetail(event: DevEvent): string {
  if (event.type === "agent-event") {
    const p = event.payload as AgentEventPayload;
    if (p.type === "STREAM" && p.chunk) return p.chunk;
    if (p.args) return JSON.stringify(p.args).slice(0, 200);
    if (p.resultPreview) return p.resultPreview.slice(0, 200);
    if (p.error) return p.error;
    if (p.description) return p.description;
    if (p.statusText) return p.statusText;
    return p.runId ?? "";
  }
  return JSON.stringify(event.payload);
}

function getEventColor(event: DevEvent): string {
  if (event.type === "agent-event") {
    const p = event.payload as AgentEventPayload;
    switch (p.type) {
      case "TOOL_START":
        return "#f0b429";
      case "TOOL_END":
        return "#8fb833";
      case "ERROR":
        return "#e53e3e";
      case "STREAM":
        return "#718096";
      case "END":
        return "#4299e1";
      default:
        if (p.type?.startsWith("TASK_")) return "#9f7aea";
        return "#a0aec0";
    }
  }
  if (event.type === "app-lifecycle") return "#ed8936";
  return "#a0aec0";
}

function EventRow({
  event,
  expanded,
  onToggle,
}: {
  event: DevEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = getEventLabel(event);
  const detail = getEventDetail(event);
  const color = getEventColor(event);

  return (
    <div
      style={{
        borderBottom: "1px solid #2d3748",
        padding: "6px 12px",
        cursor: "pointer",
        fontSize: 13,
        fontFamily: "monospace",
      }}
      onClick={onToggle}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <span style={{ color: "#718096", flexShrink: 0 }}>
          {formatTime(event.ts)}
        </span>
        <span
          style={{
            color,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        {!expanded && (
          <span
            style={{
              color: "#a0aec0",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {detail}
          </span>
        )}
      </div>
      {expanded && (
        <pre
          style={{
            marginTop: 6,
            padding: 8,
            background: "#1a202c",
            borderRadius: 4,
            fontSize: 12,
            overflow: "auto",
            maxHeight: 300,
            color: "#e2e8f0",
          }}
        >
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function App() {
  const { status, events, stellaHomePath, sendCommand, clearEvents } =
    useDevToolSocket();
  const [filter, setFilter] = useState<EventFilter>("all");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered =
    filter === "all" ? events : events.filter((e) => e.type === filter);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const statusColor =
    status === "connected"
      ? "#48bb78"
      : status === "connecting"
        ? "#ecc94b"
        : "#e53e3e";

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#171923",
        color: "#e2e8f0",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #2d3748",
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusColor,
            }}
          />
          <span style={{ fontWeight: 700, fontSize: 14 }}>Stella DevTool</span>
        </div>

        {stellaHomePath && (
          <span style={{ color: "#718096", fontSize: 12 }}>
            {stellaHomePath}
          </span>
        )}

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {EVENT_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                border: "1px solid",
                borderColor: filter === f.value ? "#4299e1" : "#4a5568",
                borderRadius: 4,
                background: filter === f.value ? "#2b6cb0" : "transparent",
                color: filter === f.value ? "#fff" : "#a0aec0",
                cursor: "pointer",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Event list */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: "auto",
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: "center",
              color: "#718096",
              fontSize: 14,
            }}
          >
            {status === "connected"
              ? "No events yet. Interact with Stella to see agent events here."
              : "Waiting for connection to Stella..."}
          </div>
        ) : (
          filtered.map((event, i) => (
            <EventRow
              key={`${event.ts}-${i}`}
              event={event}
              expanded={expandedIdx === i}
              onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
            />
          ))
        )}
      </div>

      {/* Footer — actions */}
      <div
        style={{
          padding: "8px 16px",
          borderTop: "1px solid #2d3748",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, color: "#718096", marginRight: 8 }}>
          {filtered.length} event{filtered.length !== 1 ? "s" : ""}
          {filter !== "all" ? ` (${events.length} total)` : ""}
        </span>

        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <ActionButton label="Clear Log" onClick={clearEvents} />
          <ActionButton
            label="Reload App"
            onClick={() => sendCommand("reload-app")}
          />
          <ActionButton
            label="Hard Reset"
            onClick={() => sendCommand("hard-reset")}
            confirm="Wipe .stella/ and restart the app?"
            danger
          />
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  confirm: confirmMsg,
  danger,
}: {
  label: string;
  onClick: () => void;
  confirm?: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={() => {
        if (confirmMsg && !window.confirm(confirmMsg)) return;
        onClick();
      }}
      style={{
        padding: "4px 10px",
        fontSize: 12,
        border: "1px solid",
        borderColor: danger ? "#e53e3e" : "#4a5568",
        borderRadius: 4,
        background: "transparent",
        color: danger ? "#fc8181" : "#a0aec0",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
