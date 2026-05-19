/**
 * Renderer-side mirror of `SessionStore.assembleMessageWindow`. Walks a
 * flat `EventRecord[]` in chronological order, groups by turn (boundary
 * = `user_message`), and attaches each turn's tool/`agent-completed`
 * events to the assistant message that most-recently preceded them in
 * the same turn (falling back to the turn's user_message when no
 * assistant has fired yet).
 *
 * Per-assistant attachment — rather than dumping the whole turn's tools
 * onto the FIRST assistant message — is what lets the chat render
 * linearly when an orchestrator run produces multiple assistant
 * messages (e.g. preamble → tools → post-tool answer): the tools fall
 * under the preamble row, and the post-tool answer renders as its own
 * row below them.
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
  let currentAssistant: MessageRecord | null = null;
  let pendingPreAssistantTools: EventRecord[] = [];

  /**
   * End-of-turn flush: any tools that fired in this turn without ever
   * seeing an assistant message fall back to the user_message anchor
   * (preserves the inline-artifact path for turns whose only output is
   * a fire-and-forget tool result).
   */
  const finalizePreAssistantTools = () => {
    if (pendingPreAssistantTools.length > 0 && turnUserMessage) {
      turnUserMessage.toolEvents = [
        ...turnUserMessage.toolEvents,
        ...pendingPreAssistantTools,
      ];
    }
    pendingPreAssistantTools = [];
  };

  for (const event of events) {
    if (event.type === "user_message") {
      finalizePreAssistantTools();
      const message = toMessageRecord(event);
      messages.push(message);
      turnUserMessage = message;
      currentAssistant = null;
      continue;
    }
    if (event.type === "assistant_message") {
      const message = toMessageRecord(event);
      messages.push(message);
      // Tools that fired before any assistant in this turn belong to
      // the first assistant message (so e.g. an `image_gen` tool fired
      // before the preamble text still surfaces as an inline artifact
      // on the preamble bubble). Tools that fire after this assistant
      // attach to whichever assistant is current at that moment.
      if (pendingPreAssistantTools.length > 0) {
        message.toolEvents = [
          ...message.toolEvents,
          ...pendingPreAssistantTools,
        ];
        pendingPreAssistantTools = [];
      }
      currentAssistant = message;
      continue;
    }
    if (isTurnDecorationEvent(event)) {
      if (currentAssistant) {
        currentAssistant.toolEvents = [
          ...currentAssistant.toolEvents,
          event,
        ];
      } else {
        pendingPreAssistantTools.push(event);
      }
    }
  }

  finalizePreAssistantTools();
  return messages;
};
