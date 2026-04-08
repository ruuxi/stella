import { useState, useEffect, useMemo, useRef } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import { getSetCookie } from "@better-auth/expo/client";
import { authClient } from "../../src/lib/auth-client";
import { env } from "../../src/config/env";
import { userFacingError } from "../../src/lib/user-facing-error";
import { type Colors } from "../../src/theme/colors";
import { useColors, useTheme } from "../../src/theme/theme-context";
import { fadeHex } from "../../src/theme/oklch";
import { fonts } from "../../src/theme/fonts";
import { TERMS_OF_SERVICE, PRIVACY_POLICY } from "../../src/lib/legal-text";

type LegalDoc = "terms" | "privacy" | null;

const LEGAL_TITLES = { terms: "Terms of Service", privacy: "Privacy Policy" };

const POLL_INTERVAL_MS = 2500;

type SubmitState =
  | { type: "idle" }
  | { type: "sending" }
  | { type: "sent"; requestId: string }
  | { type: "verifying" }
  | { type: "error"; message: string };

export default function LoginScreen() {
  const colors = useColors();
  const { isDark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [email, setEmail] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ type: "idle" });
  const [activeLegal, setActiveLegal] = useState<LegalDoc>(null);
  const cancelledRef = useRef(false);

  const sendMagicLink = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setSubmitState({ type: "error", message: "Enter your email." });
      return;
    }

    setSubmitState({ type: "sending" });

    try {
      const response = await fetch(
        `${env.convexSiteUrl}/api/auth/link/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmed }),
        },
      );
      const data = (await response.json()) as {
        requestId?: string;
        error?: string;
      };
      if (!response.ok || !data.requestId) {
        throw new Error(data.error || "Failed to send sign-in email.");
      }
      setSubmitState({ type: "sent", requestId: data.requestId });
    } catch (error) {
      setSubmitState({ type: "error", message: userFacingError(error) });
    }
  };

  // Poll for magic link verification.
  useEffect(() => {
    if (submitState.type !== "sent") return;
    const { requestId } = submitState;
    cancelledRef.current = false;

    const poll = async () => {
      while (!cancelledRef.current) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelledRef.current) return;

        try {
          const res = await fetch(
            `${env.convexSiteUrl}/api/auth/link/status?requestId=${encodeURIComponent(requestId)}`,
          );
          if (!res.ok) continue;
          const data = (await res.json()) as {
            status: string;
            ott?: string;
            sessionCookie?: string;
          };

          if (data.status === "completed" && data.sessionCookie) {
            if (cancelledRef.current) return;
            setSubmitState({ type: "verifying" });
            try {
              const prev = await SecureStore.getItemAsync("stella-mobile_cookie");
              const parsed = getSetCookie(data.sessionCookie, prev ?? undefined);
              await SecureStore.setItemAsync("stella-mobile_cookie", parsed);
              // Notify the session signal so useSession() re-fetches with the
              // newly-stored cookie. The expo plugin's init hook attaches it to
              // the request, and the server returns valid session data.
              const store = (authClient as unknown as { $store?: { notify: (s: string) => void } }).$store;
              store?.notify("$sessionSignal");
            } catch {
              setSubmitState({
                type: "error",
                message: "Could not finish sign-in. Please try again.",
              });
            }
            return;
          }
          if (data.status === "completed") {
            if (cancelledRef.current) return;
            setSubmitState({
              type: "error",
              message: "Sign-in incomplete. Please try again.",
            });
            return;
          }

          if (data.status === "expired") {
            if (cancelledRef.current) return;
            setSubmitState({
              type: "error",
              message: "Link expired. Please try again.",
            });
            return;
          }
        } catch {
          // Retry silently on network errors.
        }
      }
    };

    void poll();
    return () => {
      cancelledRef.current = true;
    };
  }, [submitState]);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <KeyboardAvoidingView
        style={styles.keyboardAvoid}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.hero} onPress={Keyboard.dismiss}>
          <Text style={styles.kicker}>STELLA</Text>
          <Text style={styles.title}>
            Your assistant,{"\n"}pocket-sized.
          </Text>
          <Text style={styles.body}>
            Sign in with the email you use on your computer.
          </Text>
        </Pressable>

        <View style={styles.formArea}>
        <TextInput
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor={fadeHex(colors.textMuted, 0.4)}
          style={styles.input}
          value={email}
        />

        <Pressable
          onPress={() => {
            void sendMagicLink();
          }}
          disabled={submitState.type === "sending" || submitState.type === "sent" || submitState.type === "verifying"}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed ? styles.primaryButtonPressed : null,
            submitState.type !== "idle" && submitState.type !== "error"
              ? styles.primaryButtonDisabled
              : null,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {submitState.type === "sending"
              ? "Sending..."
              : submitState.type === "verifying"
                ? "Signing in..."
                : "Continue"}
          </Text>
        </Pressable>

        {submitState.type === "sent" ? (
          <Text style={styles.successText}>
            Check your inbox and tap the link — you'll be signed in automatically.
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
      </KeyboardAvoidingView>

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

const makeStyles = (colors: Colors) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 28,
  },
  keyboardAvoid: {
    flex: 1,
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
    backgroundColor: colors.surface,
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
    color: colors.textMuted,
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
} as const);
