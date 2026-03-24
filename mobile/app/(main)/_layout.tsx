import { useEffect, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Slot, usePathname, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Feather from "@expo/vector-icons/Feather";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { colors } from "../../src/theme/colors";
import { fonts } from "../../src/theme/fonts";

type TabId = "chat" | "stella" | "account";

const TABS: {
  id: TabId;
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  href: string;
}[] = [
  { id: "chat", label: "Chat", icon: "message-square", href: "/chat" },
  { id: "stella", label: "Desktop", icon: "monitor", href: "/stella" },
  { id: "account", label: "Account", icon: "user", href: "/account" },
];

const SIDEBAR_WIDTH = 260;

function readActiveTab(pathname: string): TabId {
  if (pathname === "/stella") return "stella";
  if (pathname === "/account") return "account";
  return "chat";
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
      <Text style={styles.brand}>Stella</Text>
      <View style={styles.nav}>
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => onSelectTab(tab.id)}
              style={({ pressed }) => [
                styles.navItem,
                active && styles.navItemActive,
                pressed && styles.navItemPressed,
              ]}
            >
              <Feather
                name={tab.icon}
                size={18}
                color={active ? colors.accent : colors.textMuted}
                style={styles.navIcon}
              />
              <Text
                style={[styles.navLabel, active && styles.navLabelActive]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
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
  const sidebarAnim = useRef(new Animated.Value(0)).current;

  const activeTab = readActiveTab(pathname);

  const navigate = (tab: TabId) => {
    router.replace(TABS.find((t) => t.id === tab)!.href);
    setSidebarOpen(false);
  };

  useEffect(() => {
    Animated.timing(sidebarAnim, {
      toValue: sidebarOpen || wide ? 1 : 0,
      duration: 240,
      useNativeDriver: true,
    }).start();
  }, [sidebarAnim, sidebarOpen, wide]);

  useEffect(() => {
    if (wide) setSidebarOpen(false);
  }, [wide]);

  const translateX = sidebarAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-SIDEBAR_WIDTH, 0],
  });

  return (
    <SafeAreaView style={styles.shell}>
      <StatusBar style="dark" />
      <LinearGradient
        colors={[
          "rgba(99, 212, 255, 0.09)",
          colors.background,
          "rgba(123, 245, 219, 0.06)",
        ]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {wide ? (
        <View style={styles.wideLayout}>
          <Sidebar activeTab={activeTab} onSelectTab={navigate} />
          <View style={styles.content}>
            <Slot />
          </View>
        </View>
      ) : (
        <View style={styles.narrowLayout}>
          <View style={styles.topBar}>
            <Pressable
              onPress={() => setSidebarOpen(true)}
              hitSlop={8}
              style={styles.hamburger}
            >
              <Feather name="menu" size={22} color={colors.text} />
            </Pressable>
          </View>

          <View style={styles.content}>
            <Slot />
          </View>

          {sidebarOpen && (
            <Pressable
              onPress={() => setSidebarOpen(false)}
              style={styles.backdrop}
            />
          )}

          <Animated.View
            pointerEvents={sidebarOpen ? "auto" : "none"}
            style={[styles.drawerShell, { transform: [{ translateX }] }]}
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

  // Wide (tablet / landscape)
  wideLayout: {
    flex: 1,
    flexDirection: "row",
  },

  // Narrow (phone)
  narrowLayout: {
    flex: 1,
  },

  // Top bar — phone only
  topBar: {
    flexDirection: "row",
    height: 44,
    paddingHorizontal: 4,
  },
  hamburger: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
  },

  // Sidebar
  sidebar: {
    backgroundColor: colors.background,
    borderRightColor: colors.border,
    borderRightWidth: StyleSheet.hairlineWidth,
    flex: 1,
    paddingTop: 16,
    width: SIDEBAR_WIDTH,
  },
  brand: {
    color: colors.textMuted,
    fontFamily: fonts.sans.medium,
    fontSize: 13,
    letterSpacing: 2.6,
    paddingHorizontal: 20,
    paddingBottom: 20,
    textTransform: "uppercase",
  },
  nav: {
    gap: 2,
    paddingHorizontal: 12,
  },
  navItem: {
    alignItems: "center",
    borderRadius: 10,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  navItemActive: {
    backgroundColor: "rgba(15, 23, 40, 0.05)",
  },
  navItemPressed: {
    opacity: 0.7,
  },
  navIcon: {
    width: 20,
  },
  navLabel: {
    color: colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 15,
  },
  navLabelActive: {
    color: colors.accent,
  },

  // Drawer overlay — phone only
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
    zIndex: 4,
  },
  drawerShell: {
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
    width: SIDEBAR_WIDTH,
    zIndex: 5,
  },

  // Shared content area
  content: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 4,
  },
});
