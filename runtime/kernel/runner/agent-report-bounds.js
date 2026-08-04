export const MAX_PARENT_AGENT_REPORT_CHARS = 30_000;

export const boundParentAgentReport = (value, threadId) => {
  if (value.length <= MAX_PARENT_AGENT_REPORT_CHARS) return value;

  const buildMarker = (omitted) =>
    [
      "",
      `[middle of child report omitted: ${omitted} chars; full result remains durable on thread_id ${threadId || "unknown"}]`,
      "",
    ].join("\n");
  let marker = buildMarker(value.length - MAX_PARENT_AGENT_REPORT_CHARS);
  let available = MAX_PARENT_AGENT_REPORT_CHARS - marker.length;
  marker = buildMarker(value.length - available);
  available = MAX_PARENT_AGENT_REPORT_CHARS - marker.length;
  const headChars = Math.floor(available * 0.6);
  const tailChars = available - headChars;
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
};
