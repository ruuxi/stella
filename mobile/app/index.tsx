import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, Text } from "react-native";
import { hasMobileConfig } from "../src/config/env";
import { colors } from "../src/theme/colors";

export default function Index() {
  if (!hasMobileConfig) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.title}>Add mobile environment variables</Text>
        <Text style={styles.body}>
          Set EXPO_PUBLIC_CONVEX_URL and optionally EXPO_PUBLIC_CONVEX_SITE_URL
          before starting the app.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>Checking your session</Text>
      <Text style={styles.body}>Hang tight while Stella wakes up.</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 12,
  },
  title: {
    color: colors.text,
    fontSize: 34,
    fontWeight: "800",
    lineHeight: 40,
  },
  body: {
    color: colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
  },
});
