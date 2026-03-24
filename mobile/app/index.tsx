import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, Text } from "react-native";
import { hasMobileConfig } from "../src/config/env";
import { colors } from "../src/theme/colors";
import { fonts } from "../src/theme/fonts";

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
    fontFamily: fonts.display.regular,
    fontSize: 34,
    letterSpacing: -1.5,
    lineHeight: 38,
  },
  body: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 16,
    letterSpacing: -0.3,
    lineHeight: 24,
  },
});
