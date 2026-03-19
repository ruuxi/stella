import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { authClient } from "../src/lib/auth-client";
import { hasMobileConfig } from "../src/config/env";

function RootStack() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(main)" />
    </Stack>
  );
}

function readRouteGroup(segment: string | undefined) {
  if (segment === undefined) {
    return "index" as const;
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

    if (session.data) {
      if (routeGroup !== "main") {
        router.replace("/stella");
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
  return (
    <SafeAreaProvider>
      <AppLayout />
    </SafeAreaProvider>
  );
}
