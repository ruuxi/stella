import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage } from "../types";

const STORAGE_KEY = "stella-mobile-offline-chat-v1";
const MAX_MESSAGES = 200;

function parseRow(row: unknown): ChatMessage | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const o = row as Record<string, unknown>;
  if (typeof o.id !== "string") {
    return null;
  }
  if (o.role !== "user" && o.role !== "assistant") {
    return null;
  }
  if (typeof o.text !== "string") {
    return null;
  }
  return {
    id: o.id,
    role: o.role,
    text: o.text,
    ...(o.hasImage === true ? { hasImage: true } : {}),
  };
}

export async function loadOfflineChatMessages(): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: ChatMessage[] = [];
    for (const item of parsed) {
      const row = parseRow(item);
      if (row) {
        out.push(row);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveOfflineChatMessages(
  messages: ChatMessage[],
): Promise<void> {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}
