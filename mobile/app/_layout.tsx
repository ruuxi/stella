import { useCallback, useState } from "react";
import { Stack, usePathname, useRouter } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { loadAsync, useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { authClient } from "../src/lib/auth-client";
import { hasMobileConfig } from "../src/config/env";
import { registerForPushNotifications } from "../src/lib/notifications";
import { loadGuestMode, isGuest, setGuestMode } from "../src/lib/guest-mode";
import { loadAiConsent } from "../src/lib/ai-consent";
import {
  criticalStellaFontAssets,
  deferredStellaFontAssets,
} from "../src/theme/fonts";
import { ThemeProvider } from "../src/theme/theme-context";

void SplashScreen.preventAutoHideAsync();

function RootStack() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(main)" />
    </Stack>
  );
}

function AuthenticatedLayout() {
  const session = authClient.useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [guestReady, setGuestReady] = useState(false);

  useEffect(() => {
    void Promise.all([loadGuestMode(), loadAiConsent()]).then(() =>
      setGuestReady(true),
    );
  }, []);

  useEffect(() => {
    if (session.isPending || !guestReady) {
      return;
    }

    const onAuthCallback =
      pathname === "/auth" || pathname.startsWith("/auth/");
    const onLogin = pathname === "/login";
    const onIndex = pathname === "/" || pathname === "";
    const onMain =
      pathname.startsWith("/chat") ||
      pathname.startsWith("/stella") ||
      pathname.startsWith("/account");

    if (onAuthCallback) {
      return;
    }

    if (session.data) {
      if (isGuest()) void setGuestMode(false);
      void registerForPushNotifications();
      if (onLogin || onIndex) {
        router.replace("/chat");
      }
      return;
    }

    if (isGuest()) {
      if (onIndex || onLogin) {
        router.replace("/chat");
      }
      return;
    }

    if (onMain || onIndex) {
      router.replace("/login");
    }
  }, [pathname, router, session.data, session.isPending, guestReady]);

  return <RootStack />;
}

function AppLayout() {
  if (!hasMobileConfig) {
    return <RootStack />;
  }

  return <AuthenticatedLayout />;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts(criticalStellaFontAssets);

  useEffect(() => {
    if (!fontsLoaded) {
      return;
    }

    void loadAsync(deferredStellaFontAssets).catch(() => undefined);
  }, [fontsLoaded]);

  const onLayoutRootView = useCallback(() => {
    if (fontsLoaded) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider onLayout={onLayoutRootView}>
        <ThemeProvider>
          <AppLayout />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
