import {
  CormorantGaramond_300Light,
  CormorantGaramond_400Regular,
  CormorantGaramond_400Regular_Italic,
  CormorantGaramond_600SemiBold,
} from "@expo-google-fonts/cormorant-garamond";
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from "@expo-google-fonts/ibm-plex-mono";
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
} from "@expo-google-fonts/manrope";

export const criticalStellaFontAssets = {
  Manrope_400Regular,
  Manrope_600SemiBold,
  Manrope_700Bold,
  CormorantGaramond_300Light,
  CormorantGaramond_400Regular,
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
};

export const deferredStellaFontAssets = {
  Manrope_500Medium,
  CormorantGaramond_400Regular_Italic,
  CormorantGaramond_600SemiBold,
};

export const stellaFontAssets = {
  ...criticalStellaFontAssets,
  ...deferredStellaFontAssets,
};

export const fonts = {
  sans: {
    regular: "Manrope_400Regular",
    medium: "Manrope_500Medium",
    semiBold: "Manrope_600SemiBold",
    bold: "Manrope_700Bold",
  },
  display: {
    light: "CormorantGaramond_300Light",
    regular: "CormorantGaramond_400Regular",
    regularItalic: "CormorantGaramond_400Regular_Italic",
    semiBold: "CormorantGaramond_600SemiBold",
  },
  mono: {
    regular: "IBMPlexMono_400Regular",
    medium: "IBMPlexMono_500Medium",
  },
} as const;
