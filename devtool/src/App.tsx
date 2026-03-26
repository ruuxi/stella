import { useEffect, useRef, useState } from "react";
import { useDevToolSocket, type DevEvent } from "./use-devtool-socket";

type AgentEventPayload = {
  type: string;
  runId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  error?: string;
  chunk?: string;
  agentType?: string;
  description?: string;
  statusText?: string;
};

type EventFilter = "all" | "agent-event" | "ipc-call";

const EVENT_FILTERS: { value: EventFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "agent-event", label: "Agent" },
  { value: "ipc-call", label: "IPC" },
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
    const payload = event.payload as AgentEventPayload;
    if (payload.toolName) return `${payload.type} - ${payload.toolName}`;
    if (payload.agentType) return `${payload.type} - ${payload.agentType}`;
    return payload.type;
  }
  return event.type;
}

function getEventDetail(event: DevEvent): string {
  if (event.type === "agent-event") {
    const payload = event.payload as AgentEventPayload;
    if (payload.type === "STREAM" && payload.chunk) return payload.chunk;
    if (payload.args) return JSON.stringify(payload.args).slice(0, 200);
    if (payload.resultPreview) return payload.resultPreview.slice(0, 200);
    if (payload.error) return payload.error;
    if (payload.description) return payload.description;
    if (payload.statusText) return payload.statusText;
    return payload.runId ?? "";
  }
  return JSON.stringify(event.payload);
}

function getEventColor(event: DevEvent): string {
  if (event.type === "agent-event") {
    const payload = event.payload as AgentEventPayload;
    switch (payload.type) {
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
        if (payload.type?.startsWith("TASK_")) return "#9f7aea";
        return "#a0aec0";
    }
  }
  return "#ed8936";
}

function formatEventBlock(event: DevEvent): string {
  return `[${formatTime(event.ts)}] ${getEventLabel(event)}\n${JSON.stringify(
    event.payload,
    null,
    2,
  )}`;
}

function FlatEventLog({ events }: { events: DevEvent[] }) {
  const text = events.map((event) => formatEventBlock(event)).join("\n\n---\n\n");
  return (
    <pre
      style={{
        margin: 0,
        padding: "8px 12px",
        fontSize: 12,
        lineHeight: 1.45,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "#cbd5e0",
      }}
    >
      {text}
    </pre>
  );
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
            color: getEventColor(event),
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {getEventLabel(event)}
        </span>
        {!expanded ? (
          <span
            style={{
              color: "#a0aec0",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {getEventDetail(event)}
          </span>
        ) : null}
      </div>
      {expanded ? (
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
      ) : null}
    </div>
  );
}

function ToggleButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 10px",
        fontSize: 12,
        border: "1px solid",
        borderColor: active ? "#4299e1" : "#4a5568",
        borderRadius: 4,
        background: active ? "#2b6cb0" : "transparent",
        color: active ? "#fff" : "#a0aec0",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function ActionButton({
  label,
  onClick,
  confirm,
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
        if (confirm && !window.confirm(confirm)) return;
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

export function App() {
  const { status, events, stellaHomePath, sendCommand, clearEvents } =
    useDevToolSocket();
  const [filter, setFilter] = useState<EventFilter>("all");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [expandMode, setExpandMode] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered =
    filter === "all" ? events : events.filter((event) => event.type === filter);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filtered, autoScroll, expandMode]);

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
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #2d3748",
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexShrink: 0,
          flexWrap: "wrap",
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

        {stellaHomePath ? (
          <span style={{ color: "#718096", fontSize: 12 }}>{stellaHomePath}</span>
        ) : null}

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setExpandMode((value) => !value);
              setExpandedIdx(null);
            }}
            title="Show all events as plain text"
            style={{
              padding: "4px 10px",
              fontSize: 12,
              border: "1px solid",
              borderColor: expandMode ? "#48bb78" : "#4a5568",
              borderRadius: 4,
              background: expandMode ? "#22543d" : "transparent",
              color: expandMode ? "#c6f6d5" : "#a0aec0",
              cursor: "pointer",
            }}
          >
            Expand
          </button>
          {EVENT_FILTERS.map((entry) => (
            <ToggleButton
              key={entry.value}
              active={filter === entry.value}
              label={entry.label}
              onClick={() => setFilter(entry.value)}
            />
          ))}
        </div>
      </div>

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
              ? "No events yet. Interact with Stella to see logs here."
              : "Waiting for connection to Stella..."}
          </div>
        ) : expandMode ? (
          <FlatEventLog events={filtered} />
        ) : (
          filtered.map((event, index) => (
            <EventRow
              key={`${event.ts}-${index}`}
              event={event}
              expanded={expandedIdx === index}
              onToggle={() =>
                setExpandedIdx(expandedIdx === index ? null : index)
              }
            />
          ))
        )}
      </div>

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
          {`${filtered.length} event${filtered.length !== 1 ? "s" : ""}${
            filter !== "all" ? ` (${events.length} total)` : ""
          }`}
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
