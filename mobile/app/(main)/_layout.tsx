import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Slot, usePathname, useRouter } from "expo-router";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Feather from "@expo/vector-icons/Feather";
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { triggerStellaRefresh } from "../../src/lib/stella-refresh";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { colors } from "../../src/theme/colors";
import { fonts } from "../../src/theme/fonts";
import { ChatModePill } from "../../src/components/ChatModePill";

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
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.sidebar, { paddingTop: insets.top + 12, paddingBottom: insets.bottom }]}>
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
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Reanimated shared value: 0 = closed, 1 = fully open
  const drawerProgress = useSharedValue(0);

  const activeTab = readActiveTab(pathname);

  const openSidebar = () => {
    Keyboard.dismiss();
    setSidebarOpen(true);
    drawerProgress.value = withTiming(1, { duration: 280 });
  };

  const closeSidebar = () => {
    setSidebarOpen(false);
    drawerProgress.value = withTiming(0, { duration: 240 });
  };

  const navigate = (tab: TabId) => {
    router.replace(TABS.find((t) => t.id === tab)!.href);
    closeSidebar();
  };

  useEffect(() => {
    if (wide) closeSidebar();
  }, [wide]);

  // -- Gesture: swipe right from left edge to open --
  const openPan = Gesture.Pan()
    .activeOffsetX(15)
    .failOffsetY([-20, 20])
    .onUpdate((e) => {
      drawerProgress.value = Math.min(1, Math.max(0, e.translationX / SIDEBAR_WIDTH));
    })
    .onEnd((e) => {
      if (e.velocityX > 500 || drawerProgress.value > 0.4) {
        drawerProgress.value = withTiming(1, { duration: 200 });
        runOnJS(setSidebarOpen)(true);
      } else {
        drawerProgress.value = withTiming(0, { duration: 200 });
      }
    });

  // -- Gesture: swipe left to close --
  const makeCloseGesture = () =>
    Gesture.Pan()
      .activeOffsetX(-15)
      .failOffsetY([-20, 20])
      .onUpdate((e) => {
        drawerProgress.value = Math.min(
          1,
          Math.max(0, 1 + e.translationX / SIDEBAR_WIDTH),
        );
      })
      .onEnd((e) => {
        if (e.velocityX < -500 || drawerProgress.value < 0.6) {
          drawerProgress.value = withTiming(0, { duration: 200 });
          runOnJS(setSidebarOpen)(false);
        } else {
          drawerProgress.value = withTiming(1, { duration: 200 });
        }
      });

  const closePanBackdrop = makeCloseGesture();
  const closePanDrawer = makeCloseGesture();

  // -- Animated styles --
  const drawerStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          drawerProgress.value,
          [0, 1],
          [-SIDEBAR_WIDTH, 0],
        ),
      },
    ],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: drawerProgress.value,
  }));

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
            {activeTab === "chat" && (
              <View style={styles.wideChatHeader}>
                <ChatModePill />
              </View>
            )}
            <View style={styles.contentSlot}>
              <Slot />
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.narrowLayout}>
          <View style={styles.topBar}>
            <View style={styles.topBarSide}>
              <Pressable
                onPress={openSidebar}
                hitSlop={8}
                style={styles.hamburger}
              >
                <Feather name="menu" size={22} color={colors.text} />
              </Pressable>
            </View>
            <View style={styles.topBarCenter} pointerEvents="box-none">
              {activeTab === "chat" ? <ChatModePill /> : null}
            </View>
            <View style={styles.topBarSide}>
              {activeTab === "stella" ? (
                <Pressable
                  onPress={triggerStellaRefresh}
                  hitSlop={8}
                  style={styles.topBarAction}
                >
                  <Feather name="refresh-cw" size={18} color={colors.textMuted} />
                </Pressable>
              ) : null}
            </View>
          </View>

          <View style={styles.content}>
            <Slot />
          </View>

          {/* Backdrop — always rendered, animated opacity */}
          <GestureDetector gesture={closePanBackdrop}>
            <Animated.View
              pointerEvents={sidebarOpen ? "auto" : "none"}
              style={[
                styles.backdrop,
                { top: -insets.top, bottom: -insets.bottom },
                backdropStyle,
              ]}
            >
              <Pressable
                onPress={closeSidebar}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          </GestureDetector>

          {/* Drawer */}
          <GestureDetector gesture={closePanDrawer}>
            <Animated.View
              pointerEvents={sidebarOpen ? "auto" : "none"}
              style={[
                styles.drawerShell,
                { top: -insets.top, bottom: -insets.bottom },
                drawerStyle,
              ]}
            >
              <Sidebar activeTab={activeTab} onSelectTab={navigate} />
            </Animated.View>
          </GestureDetector>

          {/* Invisible left-edge zone for swipe-to-open */}
          {!sidebarOpen && (
            <GestureDetector gesture={openPan}>
              <Animated.View
                style={[
                  styles.edgeZone,
                  { top: -insets.top, bottom: -insets.bottom },
                ]}
              />
            </GestureDetector>
          )}
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

  // Top bar — phone only (hamburger | centered pill on Chat | action)
  topBar: {
    alignItems: "center",
    flexDirection: "row",
    height: 44,
    paddingHorizontal: 4,
  },
  topBarSide: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  topBarCenter: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  topBarAction: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  hamburger: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  wideChatHeader: {
    alignItems: "center",
    marginBottom: 8,
  },
  contentSlot: {
    flex: 1,
    minHeight: 0,
  },
  // Sidebar
  sidebar: {
    backgroundColor: colors.background,
    borderRightColor: colors.border,
    borderRightWidth: StyleSheet.hairlineWidth,
    flex: 1,
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

  // Invisible left-edge swipe zone
  edgeZone: {
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
    width: 25,
    zIndex: 3,
  },

  // Shared content area
  content: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 20,
    paddingTop: 4,
  },
});
