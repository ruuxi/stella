import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { assert, assertObject, errorMessage } from "../../src/lib/assert";
import { getConvexToken } from "../../src/lib/auth-token";
import { getJson } from "../../src/lib/http";
import { generateShimScript } from "../../src/lib/shim";
import { colors } from "../../src/theme/colors";
import { fonts } from "../../src/theme/fonts";
import type { DesktopBridgeStatus } from "../../src/types";

const timeLabel = (value: number | null) => {
  if (!value) return "Waiting for desktop";
  return `Updated ${new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
};

type BridgeState = { bridgeUrl: string; token: string; uri: string };

type ScreenState =
  | { type: "loading" }
  | {
      type: "unavailable";
      error: string | null;
      title: string;
      updatedAt: number | null;
    }
  | { type: "ready"; bridge: BridgeState; updatedAt: number | null };

type ShimMessage = { type: "openExternal"; url: string };

function readDesktopBridgeStatus(value: unknown): DesktopBridgeStatus {
  assertObject(value, "Desktop bridge response must be an object.");
  assert(typeof value.available === "boolean", "Desktop bridge availability is required.");
  assert(Array.isArray(value.baseUrls), "Desktop bridge URLs must be an array.");
  for (const item of value.baseUrls) {
    assert(typeof item === "string", "Desktop bridge URL must be a string.");
  }
  assert(
    value.platform === undefined || typeof value.platform === "string",
    "Desktop bridge platform must be a string.",
  );
  assert(
    value.updatedAt === undefined || typeof value.updatedAt === "number",
    "Desktop bridge updatedAt must be a number.",
  );
  return {
    available: value.available,
    baseUrls: value.baseUrls,
    platform: value.platform ?? null,
    updatedAt: value.updatedAt ?? null,
  };
}

function readShimMessage(data: string): ShimMessage {
  const value = JSON.parse(data) as unknown;
  assertObject(value, "WebView message must be an object.");
  assert(typeof value.type === "string", "WebView message type is required.");
  switch (value.type) {
    case "openExternal":
      assert(typeof value.url === "string", "WebView URL is required.");
      return { type: "openExternal", url: value.url };
  }
  throw new Error(`Unknown WebView message type: ${value.type}`);
}

function readUnavailableState(
  status: DesktopBridgeStatus,
): Extract<ScreenState, { type: "unavailable" }> {
  return {
    type: "unavailable",
    error: null,
    title: status.platform ? `${status.platform} desktop` : "Desktop not ready",
    updatedAt: status.updatedAt,
  };
}

export default function StellaScreen() {
  const webViewRef = useRef<WebView>(null);
  const [screenState, setScreenState] = useState<ScreenState>({ type: "loading" });
  const [canGoBack, setCanGoBack] = useState(false);
  const bridgeToken = screenState.type === "ready" ? screenState.bridge.token : null;

  const refreshBridge = async () => {
    try {
      const status = readDesktopBridgeStatus(
        await getJson("/api/mobile/desktop-bridge"),
      );
      if (!status.available) {
        setScreenState(readUnavailableState(status));
        return;
      }
      const baseUrl = status.baseUrls[0];
      assert(baseUrl, "Desktop bridge URL is required.");
      const token = await getConvexToken();
      setScreenState({
        type: "ready",
        bridge: { bridgeUrl: baseUrl, token, uri: `${baseUrl}/?mobile=1` },
        updatedAt: status.updatedAt,
      });
    } catch (error) {
      setScreenState({
        type: "unavailable",
        error: errorMessage(error),
        title: "Desktop not ready",
        updatedAt: null,
      });
    }
  };

  useEffect(() => {
    void refreshBridge();
    const interval = setInterval(() => void refreshBridge(), 45_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!bridgeToken || !webViewRef.current) return;
    webViewRef.current.injectJavaScript(
      `if(window.__stellaUpdateToken)window.__stellaUpdateToken(${JSON.stringify(bridgeToken)});true;`,
    );
  }, [bridgeToken]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const onBackPress = () => {
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [canGoBack]);

  const handleMessage = (event: WebViewMessageEvent) => {
    const message = readShimMessage(event.nativeEvent.data);
    if (message.type === "openExternal") void Linking.openURL(message.url);
  };

  // Loading
  if (screenState.type === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={colors.textMuted} />
        <Text style={styles.secondaryText}>Connecting to desktop</Text>
      </View>
    );
  }

  // Unavailable
  if (screenState.type === "unavailable") {
    return (
      <View style={styles.screen}>
        <View style={styles.statusBlock}>
          <Text style={styles.title}>{screenState.title}</Text>
          <Text style={styles.body}>
            Open Stella on your computer and sign in with the same account.
          </Text>
          <Text style={styles.meta}>{timeLabel(screenState.updatedAt)}</Text>
          {screenState.error && (
            <Text style={styles.errorText}>{screenState.error}</Text>
          )}
        </View>
        <Pressable
          onPress={() => void refreshBridge()}
          style={({ pressed }) => [
            styles.actionButton,
            pressed && styles.actionButtonPressed,
          ]}
        >
          <Text style={styles.actionButtonText}>Check again</Text>
        </Pressable>
      </View>
    );
  }

  // Ready — WebView
  return (
    <View style={styles.screen}>
      <View style={styles.webBar}>
        <Text style={styles.meta}>{timeLabel(screenState.updatedAt)}</Text>
        <Pressable
          onPress={() => void refreshBridge()}
          hitSlop={8}
        >
          <Text style={styles.linkText}>Refresh</Text>
        </Pressable>
      </View>
      <View style={styles.webFrame}>
        <WebView
          ref={webViewRef}
          source={{
            uri: screenState.bridge.uri,
            headers: { Authorization: `Bearer ${screenState.bridge.token}` },
          }}
          injectedJavaScriptBeforeContentLoaded={generateShimScript(
            screenState.bridge.bridgeUrl,
            screenState.bridge.token,
          )}
          style={styles.webView}
          onMessage={handleMessage}
          onNavigationStateChange={(nav) => setCanGoBack(nav.canGoBack)}
          mixedContentMode="always"
          onError={() =>
            setScreenState({
              type: "unavailable",
              error: "Lost connection to desktop.",
              title: "Desktop not ready",
              updatedAt: null,
            })
          }
          originWhitelist={["http://*", "https://*"]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    gap: 16,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
  },

  // Typography
  title: {
    color: colors.text,
    fontFamily: fonts.display.regular,
    fontSize: 28,
    letterSpacing: -1.2,
  },
  body: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  meta: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    letterSpacing: -0.1,
  },
  secondaryText: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
  },
  errorText: {
    color: colors.danger,
    fontFamily: fonts.sans.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  linkText: {
    color: colors.accent,
    fontFamily: fonts.sans.medium,
    fontSize: 13,
  },

  // Status block (unavailable)
  statusBlock: {
    gap: 8,
    paddingTop: 8,
  },

  // Action button
  actionButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: colors.accent,
    borderRadius: 22,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  actionButtonPressed: {
    opacity: 0.8,
  },
  actionButtonText: {
    color: colors.accentForeground,
    fontFamily: fonts.sans.semiBold,
    fontSize: 15,
    letterSpacing: -0.3,
  },

  // WebView
  webBar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 4,
  },
  webFrame: {
    borderRadius: 14,
    flex: 1,
    overflow: "hidden",
  },
  webView: {
    flex: 1,
    backgroundColor: colors.surface,
  },
});
