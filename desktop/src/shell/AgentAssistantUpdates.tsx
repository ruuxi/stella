/** Recent assistant text authored by an active background agent. */
export function AgentAssistantUpdates({
  messages,
  max,
}: {
  messages: readonly string[];
  max?: number;
}) {
  const newestFirst = [...messages].reverse();
  const visible =
    typeof max === "number" ? newestFirst.slice(0, max) : newestFirst;
  if (visible.length === 0) return null;

  return (
    <ul
      className="chat-workspace-strip__task-progress"
      aria-live="polite"
      aria-label="Recent agent messages"
    >
      {visible.map((message, index) => (
        <li
          key={`${messages.length - index}:${message}`}
          className="chat-workspace-strip__task-progress-item"
          data-newest={index === 0 ? "true" : undefined}
        >
          {message}
        </li>
      ))}
    </ul>
  );
}
