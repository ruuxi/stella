import { useMemo, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { authClient } from "../../src/lib/auth-client";
import { clearCachedToken } from "../../src/lib/auth-token";
import { isGuest } from "../../src/lib/guest-mode";
import { userFacingError } from "../../src/lib/user-facing-error";
import { tapLight } from "../../src/lib/haptics";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import { type Colors } from "../../src/theme/colors";
import { useColors, useTheme, type ThemePreference } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function AccountScreen() {
  const colors = useColors();
  const { preference, setPreference, theme: activeTheme, setThemeId, themes, isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const session = authClient.useSession();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
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
      Alert.alert("Could not delete account", userFacingError(e));
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

  if (isGuest()) {
    return (
      <View style={styles.screen}>
        <SignInPrompt message="Sign in to manage your account, subscription, and preferences." />
      </View>
    );
  }

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

      <Text style={styles.sectionLabel}>Mode</Text>
      <View style={styles.themeRow}>
        {THEME_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            onPress={() => { tapLight(); setPreference(opt.value); }}
            style={[
              styles.themeOption,
              preference === opt.value && styles.themeOptionActive,
            ]}
          >
            <Text
              style={[
                styles.themeOptionText,
                preference === opt.value && styles.themeOptionTextActive,
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.sectionLabel, { marginTop: 16 }]}>Theme</Text>
      <View style={styles.themeDots}>
        {themes.map((th) => {
          const preview = isDark ? th.dark : th.light;
          const isActive = th.id === activeTheme.id;
          return (
            <Pressable
              key={th.id}
              onPress={() => { tapLight(); setThemeId(th.id); }}
              style={[
                styles.themeDotOuter,
                isActive && { borderColor: colors.accent },
              ]}
            >
              <View style={[styles.themeDotInner, { backgroundColor: preview.accent }]} />
            </Pressable>
          );
        })}
      </View>

      <View style={styles.separator} />

      <View style={styles.legalBlock}>
        <Pressable
          onPress={() => void Linking.openURL("https://stella.sh/terms")}
          style={({ pressed }) => [styles.legalRow, pressed && styles.legalRowPressed]}
        >
          <Text style={styles.legalLabel}>Terms of Service</Text>
          <Text style={styles.legalChevron}>›</Text>
        </Pressable>
        <Pressable
          onPress={() => void Linking.openURL("https://stella.sh/privacy")}
          style={({ pressed }) => [styles.legalRow, pressed && styles.legalRowPressed]}
        >
          <Text style={styles.legalLabel}>Privacy Policy</Text>
          <Text style={styles.legalChevron}>›</Text>
        </Pressable>
      </View>

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

      <View style={styles.spacer} />

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
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
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
  legalBlock: {
    gap: 4,
    marginBottom: 12,
    marginTop: 8,
  },
  legalRow: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  legalRowPressed: {
    opacity: 0.85,
  },
  legalLabel: {
    color: colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 15,
    letterSpacing: -0.2,
  },
  legalChevron: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 18,
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
    marginBottom: 0,
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
  sectionLabel: {
    color: colors.textMuted,
    fontFamily: fonts.sans.medium,
    fontSize: 13,
    letterSpacing: 0.3,
    marginBottom: 10,
    textTransform: "uppercase",
  },
  themeRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 8,
  },
  themeOption: {
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  themeOptionActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  themeOptionText: {
    color: colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 14,
    letterSpacing: -0.2,
  },
  themeOptionTextActive: {
    color: colors.accentForeground,
  },
  themeDots: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 4,
  },
  themeDotOuter: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: 18,
    borderWidth: 2,
    justifyContent: "center",
    padding: 2,
  },
  themeDotInner: {
    borderRadius: 12,
    height: 24,
    width: 24,
  },
} as const);
