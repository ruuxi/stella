import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  FlatList,
  Image,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";
import { GlassView } from "expo-glass-effect";
import * as ImagePicker from "expo-image-picker";
import Reanimated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Feather from "@expo/vector-icons/Feather";
import {
  loadOfflineChatMessages,
  saveOfflineChatMessages,
} from "../../src/lib/offline-chat-storage";
import { postStream } from "../../src/lib/http";
import { getOrCreateMobileDeviceId } from "../../src/lib/phone-access";
import {
  getChatScreenMode,
  subscribeChatScreenMode,
  type ChatScreenMode,
} from "../../src/lib/chat-screen-mode";
import {
  checkDesktopConnection,
  connectToDesktop,
  getDesktopConnectionState,
  subscribeDesktopConnection,
} from "../../src/lib/desktop-connection";
import { userFacingError } from "../../src/lib/user-facing-error";
import { colors } from "../../src/theme/colors";
import { fonts } from "../../src/theme/fonts";
import type { ChatMessage } from "../../src/types";

// Required for LayoutAnimation on Android
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ---------------------------------------------------------------------------
// Constants — mapped from desktop full-shell.composer.css
// ---------------------------------------------------------------------------

/**
 * Content-height threshold for pill → expanded.
 * Desktop uses scrollHeight > 44 which includes padding.
 * RN onContentSizeChange reports raw text height (no padding).
 * fontSize 14 × lineHeight 1.5 ≈ 21 per line → two lines ≈ 42.
 * Use a value just above two lines so single-line typing stays pill.
 */
const EXPAND_THRESHOLD = 50;
/** LayoutAnimation config matching the same 350ms critically-damped spring */
const LAYOUT_SPRING = {
  duration: 350,
  update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
  create: {
    type: LayoutAnimation.Types.spring,
    springDamping: 1,
    property: LayoutAnimation.Properties.opacity,
  },
  delete: {
    type: LayoutAnimation.Types.spring,
    springDamping: 1,
    property: LayoutAnimation.Properties.opacity,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Animated message wrapper — mirrors desktop stream-fade-blur-in
// ---------------------------------------------------------------------------

function FadeInMessage({ children }: { children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(5)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 450,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        damping: 14,
        stiffness: 180,
        mass: 0.8,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      {children}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ChatScreen() {
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const inputRef = useRef<TextInput>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [sending, setSending] = useState(false);

  const [mode, setMode] = useState<ChatScreenMode>(() => getChatScreenMode());
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);
  const [desktopState, setDesktopState] = useState(
    () => getDesktopConnectionState(),
  );

  const [computerMessages, setComputerMessages] = useState<ChatMessage[]>([]);
  const [computerDraft, setComputerDraft] = useState("");
  const [computerSending, setComputerSending] = useState(false);
  const computerListRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    void getOrCreateMobileDeviceId().then(setMobileDeviceId);
  }, []);

  useEffect(() => {
    return subscribeChatScreenMode(setMode);
  }, []);

  useEffect(() => {
    return subscribeDesktopConnection(setDesktopState);
  }, []);

  useEffect(() => {
    void checkDesktopConnection();
    const interval = setInterval(() => void checkDesktopConnection(), 15_000);
    return () => clearInterval(interval);
  }, []);

  // Native-driven keyboard tracking (replaces KeyboardAvoidingView)
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const keyboardStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, keyboard.height.value - insets.bottom),
  }));

  // Composer expansion state — mirrors desktop Composer.tsx threshold logic
  const [expanded, setExpanded] = useState(false);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    void loadOfflineChatMessages().then((loaded) => {
      setMessages(loaded);
      setStorageLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!storageLoaded) return;
    void saveOfflineChatMessages(messages);
  }, [messages, storageLoaded]);

  const canSubmit = (draft.trim().length > 0 || attachments.length > 0) && !sending;

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Photos",
        "Allow Stella to access your photo library in Settings so you can attach images.",
        [{ text: "OK" }],
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.75,
      selectionLimit: 5,
      base64: true,
    });
    if (!result.canceled && result.assets.length > 0) {
      setAttachments((prev) => [...prev, ...result.assets]);
    }
  };

  const removeAttachment = (uri: string) => {
    setAttachments((prev) => prev.filter((a) => a.uri !== uri));
  };

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() =>
      listRef.current?.scrollToEnd({ animated: true }),
    );
  }, []);

  // --------------- Send ---------------

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending) return;

    const prior = messages;
    const history = prior.map((m) => ({ role: m.role, text: m.text }));
    const assets = attachments.slice();

    const displayText = text || (assets.length ? "Photo" : "");
    const userMsg: ChatMessage = {
      id: createId(),
      role: "user",
      text: displayText,
      hasImage: assets.length > 0,
    };

    setDraft("");
    setAttachments([]);
    setSending(true);

    if (expanded) {
      LayoutAnimation.configureNext(LAYOUT_SPRING);
      setExpanded(false);
    }

    setMessages((m) => [...m, userMsg]);
    scrollToEnd();

    const imagesPayload: { base64: string; mimeType: string }[] = [];
    for (const a of assets) {
      if (!a.base64) {
        setMessages((m) => [
          ...m,
          {
            id: createId(),
            role: "assistant",
            text: "Could not read that image. Try choosing it again.",
          },
        ]);
        setSending(false);
        return;
      }
      imagesPayload.push({
        base64: a.base64,
        mimeType: a.mimeType ?? "image/jpeg",
      });
    }

    const replyId = createId();
    setMessages((m) => [...m, { id: replyId, role: "assistant", text: "" }]);

    const onDelta = (delta: string) => {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId ? { ...msg, text: msg.text + delta } : msg,
        ),
      );
    };

    try {
      await postStream(
        "/api/mobile/offline-chat/stream",
        { message: text, history, images: imagesPayload },
        onDelta,
      );
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId && !msg.text
            ? { ...msg, text: "No reply came back. Try again." }
            : msg,
        ),
      );
    } catch (e) {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId
            ? { ...msg, text: msg.text || userFacingError(e) }
            : msg,
        ),
      );
    } finally {
      setSending(false);
    }
  };

  // --------------- Computer Send ---------------

  const sendComputer = async () => {
    const text = computerDraft.trim();
    if (!text || computerSending || !mobileDeviceId) return;

    const userMsg: ChatMessage = {
      id: createId(),
      role: "user",
      text,
    };

    setComputerDraft("");
    setComputerSending(true);
    setComputerMessages((m) => [...m, userMsg]);
    requestAnimationFrame(() =>
      computerListRef.current?.scrollToEnd({ animated: true }),
    );

    const replyId = createId();
    setComputerMessages((m) => [...m, { id: replyId, role: "assistant", text: "" }]);

    try {
      await postStream(
        "/api/mobile/chat",
        { message: text, mobileDeviceId },
        (delta) => {
          setComputerMessages((m) =>
            m.map((msg) =>
              msg.id === replyId ? { ...msg, text: msg.text + delta } : msg,
            ),
          );
        },
      );
      setComputerMessages((m) =>
        m.map((msg) =>
          msg.id === replyId && !msg.text
            ? { ...msg, text: "No reply came back. Try again." }
            : msg,
        ),
      );
    } catch (e) {
      setComputerMessages((m) =>
        m.map((msg) =>
          msg.id === replyId
            ? { ...msg, text: msg.text || userFacingError(e) }
            : msg,
        ),
      );
    } finally {
      setComputerSending(false);
    }
  };

  // --------------- TextInput content-size tracking ---------------
  // Desktop: rAF → if scrollHeight > 44 expand; if pillScrollHeight <= 44 collapse

  const handleContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      // Skip the first measurement — RN fires this on mount with an
      // unreliable initial height that can trigger a false expand.
      if (!hasMountedRef.current) {
        hasMountedRef.current = true;
        return;
      }
      const h = e.nativeEvent.contentSize.height;
      if (!expanded && h > EXPAND_THRESHOLD) {
        LayoutAnimation.configureNext(LAYOUT_SPRING);
        setExpanded(true);
      } else if (expanded && h <= EXPAND_THRESHOLD) {
        LayoutAnimation.configureNext(LAYOUT_SPRING);
        setExpanded(false);
      }
    },
    [expanded],
  );

  const empty = messages.length === 0;

  // =====================================================================
  // Render
  // =====================================================================

  const computerEmpty = computerMessages.length === 0;
  const canSubmitComputer = computerDraft.trim().length > 0 && !computerSending;

  return (
    <Reanimated.View style={[styles.screen, keyboardStyle]}>
      {mode === "chat" ? (
        <>
          {/* ---------- Chat Conversation ---------- */}
          <View style={styles.viewport}>
            {empty ? (
              <Pressable style={styles.emptyState} onPress={() => Keyboard.dismiss()}>
                <Text style={styles.emptyText}>Ask Stella anything</Text>
              </Pressable>
            ) : (
              <FlatList
                ref={listRef}
                contentContainerStyle={styles.list}
                data={messages}
                keyExtractor={(m) => m.id}
                onContentSizeChange={scrollToEnd}
                showsVerticalScrollIndicator={false}
                keyboardDismissMode="on-drag"
                fadingEdgeLength={EDGE_FADE}
                renderItem={({ item }) => (
                  <FadeInMessage>
                    {item.role === "user" ? (
                      <View style={styles.userRow}>
                        <View style={styles.userBubble}>
                          <Text style={styles.userText}>{item.text}</Text>
                          {item.hasImage ? (
                            <Text style={styles.userImageHint}>Includes a photo</Text>
                          ) : null}
                        </View>
                      </View>
                    ) : (
                      <View style={styles.assistantRow}>
                        <Text style={styles.assistantText}>{item.text}</Text>
                      </View>
                    )}
                  </FadeInMessage>
                )}
              />
            )}
          </View>

      {/* ---------- Composer ---------- */}
      {/*
        Desktop structure (full-shell.composer.css):
          .composer            → centering wrapper, padding 8 24 16
          .composer-shell      → pill/rect, shadow, overflow clip, animated h + radius
            .composer-form     → row (pill) or column (expanded)
              [add] [input] [toolbar: [add-toolbar] [stop] [submit]]
      */}
      <View style={styles.composerWrap}>
        {attachments.length > 0 && (
          <View style={styles.attachmentStrip}>
            {attachments.map((asset) => (
              <View key={asset.uri} style={styles.attachmentThumb}>
                <Image source={{ uri: asset.uri }} style={styles.attachmentImage} />
                <Pressable
                  style={styles.attachmentRemove}
                  onPress={() => removeAttachment(asset.uri)}
                  hitSlop={4}
                >
                  <Feather name="x" size={12} color={colors.accentForeground} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <GlassView style={[styles.shell, expanded ? styles.shellExpanded : styles.shellPill]}>

          {expanded ? (
            /* ---- Expanded: column, textarea on top, toolbar below ---- */
            <View style={styles.formExpanded}>
              <TextInput
                ref={inputRef}
                multiline
                onChangeText={setDraft}
                onContentSizeChange={handleContentSizeChange}
                blurOnSubmit={false}
                placeholder="Message Stella"
                placeholderTextColor="rgba(82, 104, 134, 0.35)"
                selectionColor={colors.accent}
                underlineColorAndroid="transparent"
                style={styles.inputExpanded}
                value={draft}
              />
              <View style={styles.toolbar}>
                <View style={styles.toolbarLeft}>
                  <Pressable style={styles.addButton} hitSlop={4} onPress={() => void pickImage()}>
                    <Feather name="plus" size={18} color={colors.textMuted} />
                  </Pressable>
                </View>
                <View style={styles.toolbarRight}>
                  <Pressable
                    onPress={() => void send()}
                    disabled={!canSubmit}
                    style={[
                      styles.submitButton,
                      !canSubmit && styles.submitDisabled,
                    ]}
                    hitSlop={4}
                  >
                    <Feather
                      name="arrow-up"
                      size={14}
                      color={colors.accentForeground}
                      strokeWidth={2.5}
                    />
                  </Pressable>
                </View>
              </View>
            </View>
          ) : (
            /* ---- Pill: single row, input + submit ---- */
            <View style={styles.formPill}>
              <Pressable style={styles.addButton} hitSlop={4} onPress={() => void pickImage()}>
                <Feather name="plus" size={18} color={colors.textMuted} />
              </Pressable>
              <TextInput
                ref={inputRef}
                scrollEnabled={false}
                onChangeText={setDraft}
                onContentSizeChange={handleContentSizeChange}
                blurOnSubmit
                onSubmitEditing={() => void send()}
                returnKeyType="send"
                placeholder="Message Stella"
                placeholderTextColor="rgba(82, 104, 134, 0.35)"
                selectionColor={colors.accent}
                underlineColorAndroid="transparent"
                style={styles.inputPill}
                value={draft}
              />
              <Pressable
                onPress={() => void send()}
                disabled={!canSubmit}
                style={[
                  styles.submitButton,
                  !canSubmit && styles.submitDisabled,
                ]}
                hitSlop={4}
              >
                <Feather
                  name="arrow-up"
                  size={14}
                  color={colors.accentForeground}
                  strokeWidth={2.5}
                />
              </Pressable>
            </View>
          )}
        </GlassView>
      </View>
        </>
      ) : (
        <>
          {/* ---------- Computer Pane ---------- */}
          <View style={styles.viewport}>
            {computerEmpty ? (
              <Pressable style={styles.emptyState} onPress={() => Keyboard.dismiss()}>
                {desktopState === "connected" ? (
                  <>
                    <Feather name="monitor" size={32} color={colors.textMuted} style={{ opacity: 0.4, marginBottom: 16 }} />
                    <Text style={styles.emptyText}>Your computer, at your fingertips</Text>
                    <Text style={styles.computerSubtext}>
                      Ask Stella to do things on your computer — browse the web, manage files, run tasks, and more.
                    </Text>
                  </>
                ) : desktopState === "connecting" ? (
                  <>
                    <Text style={styles.emptyText}>Connecting...</Text>
                    <Text style={styles.computerSubtext}>
                      Looking for your computer. Make sure Stella is running on your desktop.
                    </Text>
                  </>
                ) : (
                  <>
                    <Feather name="monitor" size={32} color={colors.textMuted} style={{ opacity: 0.4, marginBottom: 16 }} />
                    <Text style={styles.emptyText}>Your computer, at your fingertips</Text>
                    <Text style={styles.computerSubtext}>
                      Ask Stella to do things on your computer — browse the web, manage files, run tasks, and more.
                    </Text>
                    <Pressable
                      style={styles.connectButton}
                      onPress={() => void connectToDesktop()}
                    >
                      <Text style={styles.connectButtonText}>Connect</Text>
                    </Pressable>
                  </>
                )}
              </Pressable>
            ) : (
              <FlatList
                ref={computerListRef}
                contentContainerStyle={styles.list}
                data={computerMessages}
                keyExtractor={(m) => m.id}
                onContentSizeChange={() =>
                  requestAnimationFrame(() =>
                    computerListRef.current?.scrollToEnd({ animated: true }),
                  )
                }
                showsVerticalScrollIndicator={false}
                keyboardDismissMode="on-drag"
                fadingEdgeLength={EDGE_FADE}
                renderItem={({ item }) => (
                  <FadeInMessage>
                    {item.role === "user" ? (
                      <View style={styles.userRow}>
                        <View style={styles.userBubble}>
                          <Text style={styles.userText}>{item.text}</Text>
                        </View>
                      </View>
                    ) : (
                      <View style={styles.assistantRow}>
                        <Text style={styles.assistantText}>{item.text}</Text>
                      </View>
                    )}
                  </FadeInMessage>
                )}
              />
            )}
          </View>

          {/* Computer Composer — simple pill, no image attachments */}
          <View style={styles.composerWrap}>
            <GlassView style={[styles.shell, styles.shellPill]}>
              <View style={styles.formPill}>
                <TextInput
                  scrollEnabled={false}
                  onChangeText={setComputerDraft}
                  blurOnSubmit
                  onSubmitEditing={() => void sendComputer()}
                  returnKeyType="send"
                  placeholder={desktopState === "connected" ? "Ask Stella to do something" : "Connect to your computer first"}
                  placeholderTextColor="rgba(82, 104, 134, 0.35)"
                  selectionColor={colors.accent}
                  underlineColorAndroid="transparent"
                  style={styles.inputPill}
                  value={computerDraft}
                  editable={desktopState === "connected"}
                />
                <Pressable
                  onPress={() => void sendComputer()}
                  disabled={!canSubmitComputer || desktopState !== "connected"}
                  style={[
                    styles.submitButton,
                    (!canSubmitComputer || desktopState !== "connected") && styles.submitDisabled,
                  ]}
                  hitSlop={4}
                >
                  <Feather
                    name="arrow-up"
                    size={14}
                    color={colors.accentForeground}
                    strokeWidth={2.5}
                  />
                </Pressable>
              </View>
            </GlassView>
          </View>
        </>
      )}
    </Reanimated.View>
  );
}

// ---------------------------------------------------------------------------
// Styles
//
// Desktop mapping:
//   .composer-shell      → shell (pill capsule, shadow, overflow hidden)
//   .composer-form       → formPill (row, 48 min-h, padding 8, gap 8)
//   .composer-form.expanded → formExpanded (column)
//   .composer-input      → inputPill (flex 1, padding 4)
//   .composer-form.expanded .composer-input → inputExpanded (14 18 4, min-h 44)
//   .composer-add-button → addButton (30x30, dashed border)
//   .composer-submit     → submitButton (30x30, primary bg)
//   .composer-toolbar    → toolbar (row, padding 4 8 8)
// ---------------------------------------------------------------------------

const EDGE_FADE = 48;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  // Computer pane empty state extras
  computerSubtext: {
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 22,
    maxWidth: 280,
    marginTop: 8,
  },
  connectButton: {
    marginTop: 20,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  connectButtonText: {
    fontFamily: fonts.sans.medium,
    fontSize: 15,
    color: colors.accentForeground,
    letterSpacing: -0.2,
  },

  // Conversation — desktop: .session-messages { gap: 24px; padding: 112px 24px 24px }
  viewport: {
    flex: 1,
    position: "relative",
  },
  list: {
    gap: 24,
    paddingHorizontal: 20,
    paddingTop: 80,
    paddingBottom: EDGE_FADE,
  },
  emptyState: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  emptyText: {
    color: colors.textMuted,
    fontFamily: fonts.display.regularItalic,
    fontSize: 22,
    letterSpacing: -0.5,
    opacity: 0.45,
  },

  // User bubble — desktop: .event-item.user
  //   border-radius: 18px / tail 4px, color-mix(primary 10%), border borderStrong, max-width 85%
  userRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  userBubble: {
    backgroundColor: "rgba(29, 120, 242, 0.10)",
    borderColor: colors.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    borderBottomRightRadius: 4,
    maxWidth: "85%",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  userText: {
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 17,
    letterSpacing: 0.03 * 17,
    lineHeight: 17 * 1.45,
  },
  userImageHint: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    marginTop: 6,
    opacity: 0.7,
  },

  // Assistant — desktop: .event-item.assistant
  //   transparent bg, no border, full width, tail bottom-left 4px
  assistantRow: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  assistantText: {
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 17,
    fontWeight: "400",
    letterSpacing: 0.03 * 17,
    lineHeight: 17 * 1.45,
  },

  // ---- Composer ----

  // Desktop: .composer { padding: 8px 24px 16px }
  composerWrap: {
    alignItems: "center",
    flexShrink: 0,
    paddingBottom: Platform.OS === "ios" ? 4 : 12,
    paddingHorizontal: 16,
    paddingTop: 8,
  },

  // Attachment preview strip
  attachmentStrip: {
    flexDirection: "row",
    gap: 8,
    paddingBottom: 10,
    paddingHorizontal: 4,
  },
  attachmentThumb: {
    borderRadius: 10,
    height: 64,
    overflow: "hidden",
    position: "relative",
    width: 64,
  },
  attachmentImage: {
    borderRadius: 10,
    height: 64,
    width: 64,
  },
  attachmentRemove: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 10,
    height: 20,
    justifyContent: "center",
    position: "absolute",
    right: 3,
    top: 3,
    width: 20,
  },

  // Shell — desktop: .composer-shell { background: var(--background); shadow-md; overflow: clip }
  shell: {
    overflow: "hidden",
    width: "100%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 8,
  },
  shellPill: {
    borderRadius: 999,
  },
  shellExpanded: {
    borderRadius: 20,
  },

  // Desktop: .composer-form { min-height: 56px; padding: 10px; gap: 8px }
  formPill: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    height: 56,
    paddingHorizontal: 10,
  },

  formExpanded: {
    flexDirection: "column",
  },

  // Desktop: .composer-input { font-size: 14px; line-height: 1.5 }
  inputPill: {
    color: colors.text,
    flex: 1,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    letterSpacing: -0.2,
    lineHeight: 22,
    maxHeight: 34,
    paddingHorizontal: 6,
    paddingVertical: 0,
    ...(Platform.OS === "android" ? { textAlignVertical: "center" as const } : {}),
  },

  // Desktop: .composer-form.expanded .composer-input { padding: 14px 18px 4px; min-height: 44px }
  inputExpanded: {
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    letterSpacing: -0.2,
    lineHeight: 22,
    maxHeight: 200,
    minHeight: 44,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 4,
  },

  // Desktop: .composer-toolbar { padding: 4px 8px 8px; justify-content: space-between }
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 10,
    paddingHorizontal: 10,
    paddingTop: 4,
  },
  toolbarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  toolbarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  // Desktop: .chat-composer-icon-button--add { 30x30, 1.5px dashed border }
  addButton: {
    alignItems: "center",
    borderColor: colors.textMuted,
    borderRadius: 15,
    borderStyle: "dashed",
    borderWidth: 1.5,
    height: 30,
    justifyContent: "center",
    opacity: 0.55,
    width: 30,
  },

  // Desktop: .chat-composer-icon-button--submit { 30x30, primary bg }
  submitButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 15,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  submitDisabled: {
    opacity: 0.4,
  },
});
