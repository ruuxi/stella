import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  checkDesktopConnection,
  getDesktopConnectionState,
  subscribeDesktopConnection,
} from "../lib/desktop-connection";
import {
  getChatScreenMode,
  setChatScreenMode,
  subscribeChatScreenMode,
  type ChatScreenMode,
} from "../lib/chat-screen-mode";
import { tapLight } from "../lib/haptics";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

export function ChatModePill() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [mode, setMode] = useState<ChatScreenMode>(() => getChatScreenMode());
  const [desktopState, setDesktopState] = useState(() =>
    getDesktopConnectionState(),
  );

  useEffect(() => subscribeChatScreenMode(setMode), []);
  useEffect(() => subscribeDesktopConnection(setDesktopState), []);
  useEffect(() => {
    void checkDesktopConnection();
  }, []);

  return (
    <View style={styles.toggleRow}>
      <Pressable
        style={[styles.toggleTab, mode === "chat" && styles.toggleTabActive]}
        onPress={() => { tapLight(); setChatScreenMode("chat"); }}
      >
        <Text
          style={[styles.toggleText, mode === "chat" && styles.toggleTextActive]}
        >
          Chat
        </Text>
      </Pressable>
      <Pressable
        style={[
          styles.toggleTab,
          mode === "computer" && styles.toggleTabActive,
        ]}
        onPress={() => { tapLight(); setChatScreenMode("computer"); }}
      >
        <View style={styles.toggleWithDot}>
          <Text
            style={[
              styles.toggleText,
              mode === "computer" && styles.toggleTextActive,
            ]}
          >
            Computer
          </Text>
          {desktopState === "connected" && <View style={styles.toggleDot} />}
        </View>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  toggleRow: {
    alignSelf: "center",
    backgroundColor: colors.muted,
    borderRadius: 999,
    flexDirection: "row",
    padding: 3,
  },
  toggleTab: {
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 7,
  },
  toggleTabActive: {
    backgroundColor: colors.surface,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
  },
  toggleText: {
    color: colors.textMuted,
    fontFamily: fonts.sans.medium,
    fontSize: 14,
    letterSpacing: -0.2,
  },
  toggleTextActive: {
    color: colors.text,
  },
  toggleWithDot: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  toggleDot: {
    backgroundColor: colors.ok,
    borderRadius: 3,
    height: 6,
    width: 6,
  },
} as const);
