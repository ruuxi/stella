import { useCallback } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { loadAsync, useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { authClient } from "../src/lib/auth-client";
import { hasMobileConfig } from "../src/config/env";
import {
  criticalStellaFontAssets,
  deferredStellaFontAssets,
} from "../src/theme/fonts";

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

function readRouteGroup(segment: string | undefined) {
  if (segment === undefined) {
    return "index" as const;
  }

  if (segment === "auth") {
    return "callback" as const;
  }

  if (segment === "(auth)") {
    return "auth" as const;
  }

  if (segment === "(main)") {
    return "main" as const;
  }

  throw new Error(`Unknown root segment: ${segment}`);
}

function AuthenticatedLayout() {
  const session = authClient.useSession();
  const router = useRouter();
  const routeGroup = readRouteGroup(useSegments()[0]);

  useEffect(() => {
    if (session.isPending) {
      return;
    }

    // Don't interfere while the callback route is verifying the OTT
    if (routeGroup === "callback") {
      return;
    }

    if (session.data) {
      if (routeGroup !== "main") {
        router.replace("/chat");
      }
      return;
    }

    if (routeGroup !== "auth") {
      router.replace("/login");
    }
  }, [routeGroup, router, session.data, session.isPending]);

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
        <AppLayout />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
