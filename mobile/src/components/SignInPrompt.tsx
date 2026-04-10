import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

type Props = {
  message: string;
};

export function SignInPrompt({ message }: Props) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Text style={styles.message}>{message}</Text>
      <Pressable
        onPress={() => router.replace("/login")}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
        ]}
      >
        <Text style={styles.buttonText}>Sign in</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    container: {
      alignItems: "center",
      flex: 1,
      gap: 20,
      justifyContent: "center",
      paddingHorizontal: 32,
    },
    message: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      letterSpacing: -0.2,
      lineHeight: 23,
      textAlign: "center",
    },
    button: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 22,
      paddingHorizontal: 32,
      paddingVertical: 13,
    },
    buttonPressed: {
      backgroundColor: colors.accentHover,
    },
    buttonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
      letterSpacing: -0.3,
    },
  } as const);
