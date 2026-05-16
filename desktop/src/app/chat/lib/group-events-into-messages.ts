/**
 * Renderer-side mirror of `SessionStore.assembleMessageWindow`. Walks a
 * flat `EventRecord[]` in chronological order, groups by turn (boundary
 * = `user_message`), and attaches each turn's tool/`agent-completed`
 * events to its anchor — first assistant of the turn when one exists,
 * otherwise the user_message of the turn.
 *
 * Used by:
 *  - `useFullShellChat` for the cloud-mode chat timeline (no
 *    `listMessages` IPC equivalent on the Convex side yet — phase 2/3
 *    decides whether to add one or drop cloud mode).
 *  - Scheduled-event and optimistic-event overlays merged onto the local
 *    messages stream so synthetic user/assistant messages and just-sent
 *    placeholders surface inline without waiting for SQLite to catch up.
 *
 * Keep this in lockstep with the storage-side grouping so cloud-mode
 * and local-mode produce identical shapes.
 */
import type {
  EventRecord,
  MessageRecord,
} from "../../../../../runtime/contracts/local-chat.js";

const isTurnDecorationEvent = (event: EventRecord): boolean =>
  event.type === "tool_request" ||
  event.type === "tool_result" ||
  event.type === "agent-completed";

const toMessageRecord = (event: EventRecord): MessageRecord => ({
  _id: event._id,
  timestamp: event.timestamp,
  type: event.type,
  ...(event.deviceId ? { deviceId: event.deviceId } : {}),
  ...(event.requestId ? { requestId: event.requestId } : {}),
  ...(event.targetDeviceId ? { targetDeviceId: event.targetDeviceId } : {}),
  ...(event.payload ? { payload: event.payload } : {}),
  ...(event.channelEnvelope ? { channelEnvelope: event.channelEnvelope } : {}),
  toolEvents: [],
});

export const groupEventsIntoMessages = (
  events: readonly EventRecord[],
): MessageRecord[] => {
  const messages: MessageRecord[] = [];
  let turnUserMessage: MessageRecord | null = null;
  let firstAssistantInTurn: MessageRecord | null = null;
  let toolsInTurn: EventRecord[] = [];

  const commitTurn = () => {
    const anchor = firstAssistantInTurn ?? turnUserMessage;
    if (anchor && toolsInTurn.length > 0) {
      anchor.toolEvents = toolsInTurn;
    }
    turnUserMessage = null;
    firstAssistantInTurn = null;
    toolsInTurn = [];
  };

  for (const event of events) {
    if (event.type === "user_message") {
      commitTurn();
      const message = toMessageRecord(event);
      messages.push(message);
      turnUserMessage = message;
      continue;
    }
    if (event.type === "assistant_message") {
      const message = toMessageRecord(event);
      messages.push(message);
      if (firstAssistantInTurn === null) {
        firstAssistantInTurn = message;
      }
      continue;
    }
    if (isTurnDecorationEvent(event)) {
      toolsInTurn.push(event);
    }
  }

  commitTurn();

  return messages;
};
