import { useMemo } from "react";
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";

type Props = {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
};

export function AiConsentModal({ visible, onAccept, onDecline }: Props) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onDecline}
    >
      <SafeAreaView style={styles.container}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
        >
          <Text style={styles.title}>Before you start</Text>
          <Text style={styles.subtitle}>
            Stella uses third-party AI services to respond to your messages.
            Here's what that means for your data:
          </Text>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>What data is sent</Text>
            <Text style={styles.body}>
              When you send a message, Stella transmits your message text,
              conversation history from the current session, and any images you
              attach to an AI model for processing.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Who receives it</Text>
            <Text style={styles.body}>
              Your data is routed through the Stella Provider service to one of
              the following third-party AI model providers:{" "}
              <Text style={styles.bold}>Anthropic</Text>,{" "}
              <Text style={styles.bold}>OpenAI</Text>, or{" "}
              <Text style={styles.bold}>Google</Text>. The specific provider
              depends on model availability.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>How it's handled</Text>
            <Text style={styles.body}>
              Stella does not permanently store your messages on its servers.
              Your data passes through in transit to generate a response.
              Third-party AI providers process your data under their own privacy
              policies.
            </Text>
          </View>

          <Text style={styles.privacyLink}>
            Read our full{" "}
            <Text
              style={styles.link}
              onPress={() =>
                void Linking.openURL("https://stella.sh/privacy")
              }
            >
              Privacy Policy
            </Text>
          </Text>
        </ScrollView>

        <View style={styles.actions}>
          <Pressable
            onPress={onAccept}
            style={({ pressed }) => [
              styles.acceptButton,
              pressed && styles.acceptButtonPressed,
            ]}
          >
            <Text style={styles.acceptText}>I Understand & Agree</Text>
          </Pressable>
          <Pressable onPress={onDecline} style={styles.declineButton}>
            <Text style={styles.declineText}>Not Now</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    scroll: {
      flex: 1,
    },
    content: {
      padding: 28,
      paddingTop: 36,
      paddingBottom: 20,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display.light,
      fontStyle: "italic",
      fontSize: 32,
      letterSpacing: -1.5,
      lineHeight: 36,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      lineHeight: 23,
      marginTop: 14,
    },
    section: {
      marginTop: 24,
    },
    sectionTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.2,
      marginBottom: 6,
    },
    body: {
      color: fadeHex(colors.text, 0.82),
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      lineHeight: 22,
    },
    bold: {
      fontFamily: fonts.sans.semiBold,
      color: colors.text,
    },
    privacyLink: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      marginTop: 28,
    },
    link: {
      color: colors.accent,
      textDecorationLine: "underline",
    },
    actions: {
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: 10,
      paddingHorizontal: 28,
      paddingTop: 16,
      paddingBottom: 12,
    },
    acceptButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 14,
      paddingVertical: 17,
    },
    acceptButtonPressed: {
      backgroundColor: colors.accentHover,
    },
    acceptText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    declineButton: {
      alignItems: "center",
      paddingVertical: 12,
    },
    declineText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
    },
  } as const);
