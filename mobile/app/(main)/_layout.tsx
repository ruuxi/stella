import { useEffect, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Slot, usePathname, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { colors } from "../../src/theme/colors";

type TabId = "stella" | "chat" | "account";

const TAB_IDS: TabId[] = ["stella", "chat", "account"];

const TABS: Record<
  TabId,
  { body: string; href: string; navTitle: string; title: string }
> = {
  stella: {
    body: "Open the live desktop bridge.",
    href: "/stella",
    navTitle: "Desktop",
    title: "Stella",
  },
  chat: {
    body: "Fallback when your desktop is offline.",
    href: "/chat",
    navTitle: "Chat",
    title: "Chat",
  },
  account: {
    body: "Session and security controls.",
    href: "/account",
    navTitle: "Account",
    title: "Account",
  },
};

function readActiveTab(pathname: string): TabId {
  if (pathname === "/" || pathname === "/stella") {
    return "stella";
  }

  if (pathname === "/chat") {
    return "chat";
  }

  if (pathname === "/account") {
    return "account";
  }

  throw new Error(`Unknown route: ${pathname}`);
}

function Sidebar({
  activeTab,
  onSelectTab,
}: {
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
}) {
  return (
    <View style={styles.sidebar}>
      <Text style={styles.sidebarKicker}>STELLA</Text>
      <Text style={styles.sidebarTitle}>Mobile companion</Text>
      <Text style={styles.sidebarBody}>
        Your phone stays light. The desktop does the heavy lifting.
      </Text>

      <View style={styles.navList}>
        {TAB_IDS.map((tabId) => (
          <Pressable
            key={tabId}
            onPress={() => onSelectTab(tabId)}
            style={({ pressed }) => [
              styles.navItem,
              activeTab === tabId ? styles.navItemActive : null,
              pressed ? styles.navItemPressed : null,
            ]}
          >
            <Text
              style={[
                styles.navItemTitle,
                activeTab === tabId ? styles.navItemTitleActive : null,
              ]}
            >
              {TABS[tabId].title}
            </Text>
            <Text style={styles.navItemBody}>{TABS[tabId].body}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function MainLayout() {
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarAnimation = useRef(new Animated.Value(0)).current;

  const activeTab = readActiveTab(pathname);

  const navigate = (tab: TabId) => {
    router.replace(TABS[tab].href);
    setSidebarOpen(false);
  };

  useEffect(() => {
    Animated.timing(sidebarAnimation, {
      toValue: sidebarOpen || wide ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [sidebarAnimation, sidebarOpen, wide]);

  useEffect(() => {
    if (wide) setSidebarOpen(false);
  }, [wide]);

  const translateX = sidebarAnimation.interpolate({
    inputRange: [0, 1],
    outputRange: [-320, 0],
  });

  return (
    <SafeAreaView style={styles.shell}>
      <StatusBar style="dark" />
      <View style={styles.shellBackgroundA} />
      <View style={styles.shellBackgroundB} />

      {wide ? (
        <View style={styles.shellContentWide}>
          <Sidebar activeTab={activeTab} onSelectTab={navigate} />
          <View style={styles.contentPanel}>
            <Slot />
          </View>
        </View>
      ) : (
        <View style={styles.shellContentNarrow}>
          <View style={styles.mobileTopbar}>
            <Pressable
              onPress={() => setSidebarOpen(true)}
              style={({ pressed }) => [
                styles.menuButton,
                pressed ? styles.menuButtonPressed : null,
              ]}
            >
              <Text style={styles.menuButtonText}>Menu</Text>
            </Pressable>
            <Text style={styles.mobileTopbarTitle}>
              {TABS[activeTab].navTitle}
            </Text>
            <View style={styles.mobileTopbarSpacer} />
          </View>

          <View style={styles.contentPanel}>
            <Slot />
          </View>

          {sidebarOpen ? (
            <Pressable
              onPress={() => setSidebarOpen(false)}
              style={styles.overlayBackdrop}
            />
          ) : null}

          <Animated.View
            pointerEvents={sidebarOpen ? "auto" : "none"}
            style={[
              styles.sidebarOverlay,
              { transform: [{ translateX }] },
            ]}
          >
            <Sidebar activeTab={activeTab} onSelectTab={navigate} />
          </Animated.View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: colors.background,
  },
  shellBackgroundA: {
    position: "absolute",
    top: -60,
    right: -10,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: "#f1cfb4",
    opacity: 0.5,
  },
  shellBackgroundB: {
    position: "absolute",
    bottom: -80,
    left: -20,
    width: 240,
    height: 240,
    borderRadius: 999,
    backgroundColor: "#e8dbcb",
  },
  shellContentWide: {
    flex: 1,
    flexDirection: "row",
  },
  shellContentNarrow: {
    flex: 1,
  },
  sidebar: {
    backgroundColor: colors.panel,
    borderRightColor: colors.border,
    borderRightWidth: 1,
    gap: 10,
    paddingHorizontal: 22,
    paddingTop: 24,
    width: 320,
  },
  sidebarOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    top: 0,
    width: 320,
    zIndex: 5,
  },
  overlayBackdrop: {
    backgroundColor: colors.overlay,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 4,
  },
  sidebarKicker: {
    color: colors.accentDark,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 2,
  },
  sidebarTitle: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "800",
  },
  sidebarBody: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 10,
  },
  navList: {
    gap: 12,
    marginTop: 12,
  },
  navItem: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: 1,
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  navItemActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  navItemPressed: {
    opacity: 0.86,
  },
  navItemTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  navItemTitleActive: {
    color: colors.accentDark,
  },
  navItemBody: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  contentPanel: {
    flex: 1,
    padding: 16,
  },
  mobileTopbar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 12,
    paddingHorizontal: 16,
  },
  mobileTopbarTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  mobileTopbarSpacer: {
    width: 64,
  },
  menuButton: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    minWidth: 64,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  menuButtonPressed: {
    backgroundColor: colors.panel,
  },
  menuButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
});
