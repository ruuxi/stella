import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { authClient } from "../../src/lib/auth-client";
import { clearCachedToken } from "../../src/lib/auth-token";
import { colors } from "../../src/theme/colors";
import { fonts } from "../../src/theme/fonts";

export default function AccountScreen() {
  const session = authClient.useSession();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const user = session.data?.user;
  const email = user?.email ?? "";
  const name = user?.name || email || "Account";

  const signOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      clearCachedToken();
    } finally {
      setIsSigningOut(false);
    }
  };

  if (!user) {
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>Account</Text>
        <Text style={styles.body}>
          {isSigningOut ? "Signing out\u2026" : "Loading session\u2026"}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{name}</Text>
      {email !== name && <Text style={styles.body}>{email}</Text>}

      <View style={styles.separator} />

      <Text style={styles.caption}>
        Uses the same session as your desktop.
      </Text>

      <View style={styles.spacer} />

      <Pressable
        onPress={() => void signOut()}
        disabled={isSigningOut}
        style={({ pressed }) => [
          styles.signOut,
          pressed && styles.signOutPressed,
          isSigningOut && styles.signOutDisabled,
        ]}
      >
        <Text style={styles.signOutText}>
          {isSigningOut ? "Signing out\u2026" : "Sign out"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingTop: 8,
  },
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
    marginTop: 4,
  },
  separator: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginVertical: 20,
  },
  caption: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 14,
    letterSpacing: -0.1,
    lineHeight: 20,
  },
  spacer: {
    flex: 1,
  },
  signOut: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: "rgba(220, 38, 38, 0.2)",
    borderRadius: 22,
    borderWidth: 1,
    marginBottom: 24,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  signOutPressed: {
    backgroundColor: "rgba(220, 38, 38, 0.06)",
  },
  signOutDisabled: {
    opacity: 0.5,
  },
  signOutText: {
    color: colors.danger,
    fontFamily: fonts.sans.medium,
    fontSize: 15,
    letterSpacing: -0.3,
  },
});
