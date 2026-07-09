import { createContext } from "react";
import type { MessageRecord } from "../../../runtime/contracts/local-chat.js";

/**
 * High-frequency channel for the live chat timeline.
 *
 * While a reply streams, each provider chunk updates the visible message list
 * (`setStreamingAssistants` → `displayMessages`). That array is deliberately
 * kept OUT of
 * `ChatRuntimeContext` and published here instead, so:
 *
 *   - the stable chat-runtime value stops changing identity every frame
 *     (its consumers — the shell chrome, left sidebar, mobile bridge —
 *     re-render only when *their* slices change, not per provider chunk),
 *   - only the components that actually paint the timeline (`ChatColumn`,
 *     the right-panel `ChatDisplayTab`) subscribe to this context and take
 *     the streaming re-render.
 *
 * Value-only / hook-free module so both the Provider file and the
 * `useChatMessages` hook stay Fast-Refresh eligible, mirroring the
 * `chat-runtime-context.ts` split.
 */
export const ChatMessagesContext = createContext<MessageRecord[] | null>(null);
