import { useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { assert, assertObject, errorMessage } from "../../src/lib/assert";
import { postJson } from "../../src/lib/http";
import { colors } from "../../src/theme/colors";
import type { ChatMessage } from "../../src/types";

const INTRO_MESSAGE: ChatMessage = {
  id: "intro",
  role: "assistant",
  text: "This chat is for when your desktop is offline. Messages stay in memory on this phone and are not stored in Stella's database.",
};

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function readOfflineChatText(value: unknown) {
  assertObject(value, "Offline chat response must be an object.");
  assert(typeof value.text === "string", "Offline chat response text is required.");
  return value.text;
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([INTRO_MESSAGE]);
  const [draft, setDraft] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending">("idle");

  const sendMessage = async () => {
    const text = draft.trim();
    if (!text || sendState === "sending") {
      return;
    }

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      text,
    };

    setDraft("");
    setSendState("sending");
    setMessages((current) => [...current, userMessage]);

    try {
      const response = await postJson("/api/mobile/offline-chat", { message: text });
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          text: readOfflineChatText(response),
        },
      ]);
    } catch (error) {
      const message = errorMessage(error);
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          text: `I couldn't answer that right now. ${message}`,
        },
      ]);
    } finally {
      setSendState("idle");
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>Offline chat</Text>
        <Text style={styles.screenBody}>
          Use this when Stella on desktop is unavailable.
        </Text>
      </View>

      <FlatList
        contentContainerStyle={styles.chatList}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View
            style={[
              styles.chatBubble,
              item.role === "user"
                ? styles.chatBubbleUser
                : styles.chatBubbleAssistant,
            ]}
          >
            <Text
              style={[
                styles.chatRole,
                item.role === "user" ? styles.chatRoleUser : null,
              ]}
            >
              {item.role === "user" ? "You" : "Stella"}
            </Text>
            <Text style={styles.chatText}>{item.text}</Text>
          </View>
        )}
      />

      <View style={styles.composerCard}>
        <TextInput
          multiline
          onChangeText={setDraft}
          placeholder="Ask Stella something"
          placeholderTextColor={colors.textMuted}
          style={styles.composerInput}
          value={draft}
        />
        <View style={styles.composerFooter}>
          <Text style={styles.composerHint}>
            This thread disappears when you leave the app.
          </Text>
          <Pressable
            onPress={() => {
              void sendMessage();
            }}
            style={({ pressed }) => [
              styles.sendButton,
              pressed ? styles.sendButtonPressed : null,
              sendState === "sending" ? styles.sendButtonDisabled : null,
            ]}
          >
            <Text style={styles.sendButtonText}>
              {sendState === "sending" ? "Sending..." : "Send"}
            </Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    gap: 14,
  },
  screenHeader: {
    gap: 6,
    paddingTop: 4,
  },
  screenTitle: {
    color: colors.text,
    fontSize: 30,
    fontWeight: "800",
  },
  screenBody: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
  },
  chatList: {
    gap: 12,
    paddingBottom: 8,
  },
  chatBubble: {
    borderRadius: 22,
    maxWidth: "88%",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  chatBubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  chatBubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
    borderWidth: 1,
  },
  chatRole: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  chatRoleUser: {
    color: colors.accentDark,
  },
  chatText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  composerCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 24,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  composerInput: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 150,
    minHeight: 80,
    textAlignVertical: "top",
  },
  composerFooter: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  composerHint: {
    color: colors.textMuted,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  sendButton: {
    backgroundColor: colors.text,
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  sendButtonPressed: {
    opacity: 0.9,
  },
  sendButtonDisabled: {
    opacity: 0.7,
  },
  sendButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
});
