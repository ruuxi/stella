import { useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { authClient } from "../../src/lib/auth-client";
import { env } from "../../src/config/env";
import { errorMessage } from "../../src/lib/assert";
import { colors } from "../../src/theme/colors";

type SubmitState =
  | { type: "idle" }
  | { type: "sending" }
  | { type: "sent" }
  | { type: "error"; message: string };

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ type: "idle" });

  const sendMagicLink = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setSubmitState({ type: "error", message: "Enter your email." });
      return;
    }

    setSubmitState({ type: "sending" });

    try {
      await authClient.$fetch("/sign-in/magic-link", {
        method: "POST",
        body: {
          email: trimmed,
          callbackURL: `${env.mobileScheme}://auth`,
        },
      });
      setSubmitState({ type: "sent" });
    } catch (error) {
      setSubmitState({ type: "error", message: errorMessage(error) });
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.hero}>
        <Text style={styles.kicker}>STELLA MOBILE</Text>
        <Text style={styles.title}>Your desktop assistant, pocket-sized.</Text>
        <Text style={styles.body}>
          Sign in with the same account you use on desktop. Stella keeps mobile
          chat ephemeral and only opens your desktop bridge once your machine
          verifies you.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Sign in</Text>
        <Text style={styles.cardBody}>
          We&apos;ll email a magic link that opens Stella directly on this
          phone.
        </Text>

        <TextInput
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          value={email}
        />

        <Pressable
          onPress={() => {
            void sendMagicLink();
          }}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed ? styles.primaryButtonPressed : null,
            submitState.type === "sending" ? styles.primaryButtonDisabled : null,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {submitState.type === "sending"
              ? "Sending..."
              : "Email me a sign-in link"}
          </Text>
        </Pressable>

        {submitState.type === "sent" ? (
          <Text style={styles.successText}>
            Check your inbox, then open the link on this phone.
          </Text>
        ) : null}

        {submitState.type === "error" ? (
          <Text style={styles.errorText}>{submitState.message}</Text>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 24,
    paddingVertical: 28,
    justifyContent: "space-between",
  },
  hero: {
    marginTop: 12,
    gap: 12,
  },
  kicker: {
    color: colors.accentDark,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2,
  },
  title: {
    color: colors.text,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: "800",
  },
  body: {
    color: colors.textMuted,
    fontSize: 16,
    lineHeight: 24,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 28,
    borderWidth: 1,
    gap: 14,
    padding: 22,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
  },
  cardTitle: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
  },
  cardBody: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
  },
  input: {
    backgroundColor: "#fff",
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 15,
  },
  primaryButtonPressed: {
    backgroundColor: colors.accentDark,
  },
  primaryButtonDisabled: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: "#fff7f2",
    fontSize: 16,
    fontWeight: "700",
  },
  successText: {
    color: colors.ok,
    fontSize: 14,
    lineHeight: 20,
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
