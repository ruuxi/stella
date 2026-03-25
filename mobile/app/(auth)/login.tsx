import { useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { authClient } from "../../src/lib/auth-client";
import { env } from "../../src/config/env";
import { errorMessage } from "../../src/lib/assert";
import { colors } from "../../src/theme/colors";
import { fonts } from "../../src/theme/fonts";
import { TERMS_OF_SERVICE, PRIVACY_POLICY } from "../../src/lib/legal-text";

type LegalDoc = "terms" | "privacy" | null;

const LEGAL_TITLES = { terms: "Terms of Service", privacy: "Privacy Policy" };

type SubmitState =
  | { type: "idle" }
  | { type: "sending" }
  | { type: "sent" }
  | { type: "error"; message: string };

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ type: "idle" });
  const [activeLegal, setActiveLegal] = useState<LegalDoc>(null);

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
          callbackURL: new URL("/auth/callback?client=mobile", env.siteUrl).href,
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
        <Text style={styles.kicker}>STELLA</Text>
        <Text style={styles.title}>
          Your assistant,{"\n"}pocket-sized.
        </Text>
        <Text style={styles.body}>
          Sign in with the email you use on your computer.
        </Text>
      </View>

      <View style={styles.formArea}>
        <TextInput
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor="rgba(82, 104, 134, 0.4)"
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
            {submitState.type === "sending" ? "Sending..." : "Continue"}
          </Text>
        </Pressable>

        {submitState.type === "sent" ? (
          <Text style={styles.successText}>
            Check your inbox and open the link on this phone.
          </Text>
        ) : null}

        {submitState.type === "error" ? (
          <Text style={styles.errorText}>{submitState.message}</Text>
        ) : null}

        <Text style={styles.legalFooter}>
          By continuing, you agree to our{" "}
          <Text
            style={styles.legalLink}
            onPress={() => setActiveLegal("terms")}
          >
            Terms
          </Text>
          {" and "}
          <Text
            style={styles.legalLink}
            onPress={() => setActiveLegal("privacy")}
          >
            Privacy Policy
          </Text>
          .
        </Text>
      </View>

      <Modal
        visible={activeLegal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setActiveLegal(null)}
      >
        <SafeAreaView style={styles.legalModal}>
          <View style={styles.legalModalHeader}>
            <Text style={styles.legalModalTitle}>
              {activeLegal ? LEGAL_TITLES[activeLegal] : ""}
            </Text>
            <Pressable
              onPress={() => setActiveLegal(null)}
              style={styles.legalModalClose}
            >
              <Text style={styles.legalModalCloseText}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            style={styles.legalModalScroll}
            contentContainerStyle={styles.legalModalContent}
          >
            <Text style={styles.legalModalBody}>
              {activeLegal === "terms"
                ? TERMS_OF_SERVICE
                : activeLegal === "privacy"
                  ? PRIVACY_POLICY
                  : ""}
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 28,
    justifyContent: "space-between",
  },
  hero: {
    flex: 1,
    justifyContent: "center",
    gap: 14,
  },
  kicker: {
    color: colors.textMuted,
    fontFamily: fonts.mono.medium,
    fontSize: 11,
    letterSpacing: 1.5,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.display.light,
    fontStyle: "italic",
    fontSize: 42,
    letterSpacing: -2,
    lineHeight: 42,
  },
  body: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 17,
    letterSpacing: -0.3,
    lineHeight: 24,
    marginTop: 2,
  },
  formArea: {
    gap: 12,
    paddingBottom: 16,
  },
  input: {
    backgroundColor: "rgba(255, 255, 255, 0.8)",
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 17,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 17,
  },
  primaryButtonPressed: {
    backgroundColor: colors.accentHover,
  },
  primaryButtonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: colors.accentForeground,
    fontFamily: fonts.sans.semiBold,
    fontSize: 17,
    letterSpacing: -0.3,
  },
  successText: {
    color: colors.ok,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  errorText: {
    color: colors.danger,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  legalFooter: {
    color: "rgba(82, 104, 134, 0.5)",
    fontFamily: fonts.sans.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
    marginTop: 4,
  },
  legalLink: {
    textDecorationLine: "underline",
  },
  legalModal: {
    flex: 1,
    backgroundColor: colors.background,
  },
  legalModalHeader: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  legalModalTitle: {
    color: colors.text,
    fontFamily: fonts.sans.semiBold,
    fontSize: 18,
    letterSpacing: -0.4,
  },
  legalModalClose: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  legalModalCloseText: {
    color: colors.accent,
    fontFamily: fonts.sans.semiBold,
    fontSize: 16,
  },
  legalModalScroll: {
    flex: 1,
  },
  legalModalContent: {
    padding: 20,
    paddingBottom: 40,
  },
  legalModalBody: {
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    lineHeight: 20,
    opacity: 0.8,
  },
});
