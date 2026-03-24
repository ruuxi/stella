import { useEffect, useRef, useState } from "react";
import {
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
  if (!value) {
    return "Waiting for Stella to register this desktop.";
  }

  return `Updated ${new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
};

type BridgeState = {
  bridgeUrl: string;
  token: string;
  uri: string;
};

type ScreenState =
  | { type: "loading" }
  | {
      type: "unavailable";
      error: string | null;
      title: string;
      updatedAt: number | null;
    }
  | {
      type: "ready";
      bridge: BridgeState;
      updatedAt: number | null;
    };

type ShimMessage = {
  type: "openExternal";
  url: string;
};

function readDesktopBridgeStatus(value: unknown): DesktopBridgeStatus {
  assertObject(value, "Desktop bridge response must be an object.");
  assert(
    typeof value.available === "boolean",
    "Desktop bridge availability is required.",
  );
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
  const [screenState, setScreenState] = useState<ScreenState>({
    type: "loading",
  });
  const [canGoBack, setCanGoBack] = useState(false);
  const bridgeToken =
    screenState.type === "ready" ? screenState.bridge.token : null;

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
        bridge: {
          bridgeUrl: baseUrl,
          token,
          uri: `${baseUrl}/?mobile=1`,
        },
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
    const interval = setInterval(() => {
      void refreshBridge();
    }, 45_000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!bridgeToken || !webViewRef.current) {
      return;
    }

    webViewRef.current.injectJavaScript(
      `if(window.__stellaUpdateToken)window.__stellaUpdateToken(${JSON.stringify(bridgeToken)});true;`,
    );
  }, [bridgeToken]);

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }

    const onBackPress = () => {
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }

      return false;
    };

    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      onBackPress,
    );
    return () => subscription.remove();
  }, [canGoBack]);

  const handleMessage = (event: WebViewMessageEvent) => {
    const message = readShimMessage(event.nativeEvent.data);

    switch (message.type) {
      case "openExternal":
        void Linking.openURL(message.url);
        return;
    }
  };

  if (screenState.type === "loading") {
    return (
      <View style={styles.screenCentered}>
        <Text style={styles.screenTitle}>Connecting to desktop</Text>
        <Text style={styles.screenBody}>
          Looking for the Stella app running on your computer.
        </Text>
      </View>
    );
  }

  if (screenState.type === "unavailable") {
    return (
      <View style={styles.screen}>
        <View style={styles.screenHeader}>
          <Text style={styles.screenTitle}>Desktop bridge</Text>
          <Text style={styles.screenBody}>
            Open Stella on your desktop and keep it signed in on the same
            account to use this tab.
          </Text>
        </View>

        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>{screenState.title}</Text>
          <Text style={styles.stateBody}>{timeLabel(screenState.updatedAt)}</Text>
          {screenState.error ? (
            <Text style={styles.errorText}>{screenState.error}</Text>
          ) : null}
          <Pressable
            onPress={() => {
              void refreshBridge();
            }}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed ? styles.primaryButtonPressed : null,
            ]}
          >
            <Text style={styles.primaryButtonText}>Check again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.webHeader}>
        <View style={styles.webHeaderText}>
          <Text style={styles.screenTitle}>Desktop</Text>
          <Text style={styles.screenBody}>{timeLabel(screenState.updatedAt)}</Text>
        </View>
        <Pressable
          onPress={() => {
            void refreshBridge();
          }}
          style={({ pressed }) => [
            styles.ghostButton,
            pressed ? styles.ghostButtonPressed : null,
          ]}
        >
          <Text style={styles.ghostButtonText}>Refresh</Text>
        </Pressable>
      </View>

      <View style={styles.webCard}>
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
          onNavigationStateChange={(navState) => {
            setCanGoBack(navState.canGoBack);
          }}
          mixedContentMode="always"
          onError={() => {
            setScreenState({
              type: "unavailable",
              error: "Lost connection to desktop.",
              title: "Desktop not ready",
              updatedAt: null,
            });
          }}
          originWhitelist={["http://*", "https://*"]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    gap: 14,
  },
  screenCentered: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 10,
  },
  screenHeader: {
    gap: 6,
    paddingTop: 4,
  },
  screenTitle: {
    color: colors.text,
    fontFamily: fonts.display.regular,
    fontSize: 30,
    letterSpacing: -1.5,
  },
  screenBody: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  stateCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 20,
    shadowColor: "#2f5082",
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  stateTitle: {
    color: colors.text,
    fontFamily: fonts.display.regular,
    fontSize: 24,
    letterSpacing: -1,
  },
  stateBody: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  primaryButtonPressed: {
    backgroundColor: colors.accentHover,
  },
  primaryButtonText: {
    color: colors.accentForeground,
    fontFamily: fonts.sans.bold,
    fontSize: 15,
    letterSpacing: -0.4,
  },
  errorText: {
    color: colors.danger,
    fontFamily: fonts.sans.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  webHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  webHeaderText: {
    flex: 1,
    gap: 4,
  },
  webCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    overflow: "hidden",
    shadowColor: "#2f5082",
    shadowOpacity: 0.08,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
  },
  webView: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  ghostButton: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    shadowColor: "#2f5082",
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  ghostButtonPressed: {
    backgroundColor: colors.panel,
  },
  ghostButtonText: {
    color: colors.text,
    fontFamily: fonts.sans.semiBold,
    fontSize: 14,
    letterSpacing: -0.3,
  },
});
