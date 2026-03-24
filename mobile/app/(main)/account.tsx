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
  const name = user?.name || email || "Your account";

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
        <View style={styles.screenHeader}>
          <Text style={styles.screenTitle}>Account</Text>
          <Text style={styles.screenBody}>
            {isSigningOut
              ? "Signing you out of Stella."
              : "Refreshing your account session."}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>Account</Text>
        <Text style={styles.screenBody}>
          Stella mobile uses the same account session as your desktop.
        </Text>
      </View>

      <View style={styles.stateCard}>
        <Text style={styles.accountLabel}>Signed in as</Text>
        <Text style={styles.accountValue}>{name}</Text>
        <Text style={styles.accountMeta}>{email}</Text>
        <Text style={styles.accountMeta}>
          Desktop bridge requests are verified against this account before your
          phone can open Stella.
        </Text>

        <Pressable
          onPress={() => {
            void signOut();
          }}
          style={({ pressed }) => [
            styles.dangerButton,
            pressed ? styles.dangerButtonPressed : null,
            isSigningOut ? styles.dangerButtonDisabled : null,
          ]}
        >
          <Text style={styles.dangerButtonText}>
            {isSigningOut ? "Signing out..." : "Sign out"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    gap: 14,
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
  accountLabel: {
    color: colors.textMuted,
    fontFamily: fonts.mono.regular,
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  accountValue: {
    color: colors.text,
    fontFamily: fonts.display.regular,
    fontSize: 26,
    letterSpacing: -1,
  },
  accountMeta: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  dangerButton: {
    alignItems: "center",
    backgroundColor: "rgba(220, 38, 38, 0.08)",
    borderColor: "rgba(220, 38, 38, 0.18)",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 8,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  dangerButtonPressed: {
    backgroundColor: "rgba(220, 38, 38, 0.14)",
  },
  dangerButtonDisabled: {
    opacity: 0.7,
  },
  dangerButtonText: {
    color: colors.danger,
    fontFamily: fonts.sans.semiBold,
    fontSize: 15,
    letterSpacing: -0.3,
  },
});
