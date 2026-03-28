import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { authClient } from "../../src/lib/auth-client";
import { clearCachedToken } from "../../src/lib/auth-token";
import { colors } from "../../src/theme/colors";
import { fonts } from "../../src/theme/fonts";

export default function AccountScreen() {
  const session = authClient.useSession();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const user = session.data?.user;
  const email = user?.email ?? "";
  const name = user?.name || email || "Account";
  const isAnonymous =
    user !== undefined &&
    typeof user === "object" &&
    "isAnonymous" in user &&
    (user as { isAnonymous?: boolean }).isAnonymous === true;

  const signOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      clearCachedToken();
    } finally {
      setIsSigningOut(false);
    }
  };

  const runDeleteAccount = async () => {
    setIsDeletingAccount(true);
    try {
      const client = authClient as unknown as {
        deleteUser?: (args?: { callbackURL?: string }) => Promise<unknown>;
      };
      if (typeof client.deleteUser !== "function") {
        throw new Error("Account deletion is not available in this build.");
      }
      await client.deleteUser({});
      clearCachedToken();
      await authClient.signOut();
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Something went wrong. Try again.";
      Alert.alert("Could not delete account", message);
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      "Delete account",
      "This permanently deletes your Stella account and removes cloud data associated with it on our servers. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => void runDeleteAccount(),
        },
      ],
    );
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

      {!isAnonymous ? (
        <Pressable
          onPress={confirmDeleteAccount}
          disabled={isDeletingAccount || isSigningOut}
          style={({ pressed }) => [
            styles.deleteAccount,
            pressed && styles.deleteAccountPressed,
            (isDeletingAccount || isSigningOut) && styles.deleteAccountDisabled,
          ]}
        >
          <Text style={styles.deleteAccountText}>
            {isDeletingAccount ? "Deleting account\u2026" : "Delete account"}
          </Text>
        </Pressable>
      ) : null}

      <Pressable
        onPress={() => void signOut()}
        disabled={isSigningOut || isDeletingAccount}
        style={({ pressed }) => [
          styles.signOut,
          pressed && styles.signOutPressed,
          (isSigningOut || isDeletingAccount) && styles.signOutDisabled,
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
  deleteAccount: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: "rgba(220, 38, 38, 0.35)",
    borderRadius: 22,
    borderWidth: 1,
    marginBottom: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  deleteAccountPressed: {
    backgroundColor: "rgba(220, 38, 38, 0.06)",
  },
  deleteAccountDisabled: {
    opacity: 0.5,
  },
  deleteAccountText: {
    color: colors.danger,
    fontFamily: fonts.sans.medium,
    fontSize: 15,
    letterSpacing: -0.3,
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
