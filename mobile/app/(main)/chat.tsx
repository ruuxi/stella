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
import { LinearGradient } from "expo-linear-gradient";
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
import { postJson } from "../../src/lib/http";
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

function readOfflineChatText(value: unknown): string {
  if (
    value
    && typeof value === "object"
    && typeof (value as { text?: unknown }).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Animated message wrapper — mirrors desktop stream-fade-blur-in
// ---------------------------------------------------------------------------

function FadeInMessage({ children }: { children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(4)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        damping: 18,
        stiffness: 200,
        mass: 1,
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
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

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

    try {
      const res = await postJson("/api/mobile/offline-chat", {
        message: text,
        history,
        images: imagesPayload,
      });
      const reply = readOfflineChatText(res);
      setMessages((m) => [
        ...m,
        {
          id: createId(),
          role: "assistant",
          text: reply || "No reply came back. Try again.",
        },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: createId(), role: "assistant", text: userFacingError(e) },
      ]);
    } finally {
      setSending(false);
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

  // --------------- Scroll edge tracking ---------------

  const handleScroll = useCallback(
    (e: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize: { height: number };
        layoutMeasurement: { height: number };
      };
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      setAtTop(contentOffset.y <= 2);
      setAtBottom(
        contentOffset.y + layoutMeasurement.height >= contentSize.height - 2,
      );
    },
    [],
  );

  const empty = messages.length === 0;

  // =====================================================================
  // Render
  // =====================================================================

  return (
    <Reanimated.View style={[styles.screen, keyboardStyle]}>
      {/* ---------- Conversation ---------- */}
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
            onScroll={handleScroll}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="on-drag"
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

        {/* Gradient edge masks */}
        {!atTop && !empty && (
          <LinearGradient
            colors={[colors.background, "transparent"]}
            style={styles.edgeTop}
            pointerEvents="none"
          />
        )}
        {!atBottom && !empty && (
          <LinearGradient
            colors={["transparent", colors.background]}
            style={styles.edgeBottom}
            pointerEvents="none"
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

  // Conversation
  viewport: {
    flex: 1,
    position: "relative",
  },
  list: {
    gap: 8,
    paddingHorizontal: 4,
    paddingTop: 8,
    paddingBottom: 12,
  },
  edgeTop: {
    height: EDGE_FADE,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  edgeBottom: {
    bottom: 0,
    height: EDGE_FADE,
    left: 0,
    position: "absolute",
    right: 0,
  },
  emptyState: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  emptyText: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 17,
    letterSpacing: -0.2,
    opacity: 0.5,
  },

  // User bubble — desktop: color-mix(in oklch, var(--primary) 12%, transparent)
  userRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  userBubble: {
    backgroundColor: "rgba(29, 120, 242, 0.12)",
    borderRadius: 12,
    maxWidth: "85%",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  userText: {
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 18,
    letterSpacing: 0.54,
    lineHeight: 26,
  },
  userImageHint: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 12,
    marginTop: 4,
    opacity: 0.75,
  },

  // Assistant — desktop: transparent, no border, full width
  assistantRow: {
    paddingHorizontal: 2,
    paddingVertical: 10,
  },
  assistantText: {
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 18,
    letterSpacing: 0.54,
    lineHeight: 26,
  },

  // ---- Composer ----

  // Outer centering wrapper — desktop: .composer (padding 8 24 16, centered)
  composerWrap: {
    alignItems: "center",
    flexShrink: 0,
    paddingBottom: Platform.OS === "ios" ? 4 : 10,
    paddingHorizontal: 4,
    paddingTop: 8,
  },

  // Attachment preview strip — above the composer shell
  attachmentStrip: {
    flexDirection: "row",
    gap: 8,
    paddingBottom: 8,
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

  // Shell — desktop: .composer-shell (pill radius, shadow, overflow clip)
  shell: {
    overflow: "hidden",
    width: "100%",
  },
  // Pill capsule — desktop: border-radius: 999px (CSS fallback)
  shellPill: {
    borderRadius: 999,
  },
  // Expanded rect — desktop: motion animates to 20px
  shellExpanded: {
    borderRadius: 20,
  },

  // Pill form — desktop: .composer-form (row, min-h 48, padding 8, gap 8)
  formPill: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    height: 48,
    paddingHorizontal: 8,
  },

  // Expanded form — desktop: .composer-form.expanded (column, no padding)
  formExpanded: {
    flexDirection: "column",
  },

  // Input – pill — desktop: .composer-input (flex 1, padding 4 4)
  inputPill: {
    color: colors.text,
    flex: 1,
    fontFamily: fonts.sans.regular,
    fontSize: 14,
    letterSpacing: -0.01,
    lineHeight: 21,
    maxHeight: 32,
    paddingHorizontal: 4,
    paddingVertical: 0,
    // Remove default Android underline / iOS focus ring
    ...(Platform.OS === "android" ? { textAlignVertical: "center" as const } : {}),
  },

  // Input – expanded — desktop: .composer-form.expanded .composer-input
  //   (width 100%, padding 14 18 4, min-h 44, order -1)
  inputExpanded: {
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 14,
    letterSpacing: -0.01,
    lineHeight: 21,
    maxHeight: 200,
    minHeight: 44,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 4,
  },

  // Toolbar — desktop: .composer-form.expanded .composer-toolbar
  //   (flex row, space-between, padding 4 8 8)
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 8,
    paddingHorizontal: 8,
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

  // Add button — desktop: .chat-composer-icon-button--add
  //   (30x30, 1.5px dashed border, transparent bg)
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

  // Submit — desktop: .chat-composer-icon-button--submit
  //   (30x30, primary bg, primary-foreground color)
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
