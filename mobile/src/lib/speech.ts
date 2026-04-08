/**
 * Safe wrapper around expo-speech-recognition.
 * Falls back to no-ops when the native module isn't available (e.g. Expo Go).
 */

let mod: typeof import("expo-speech-recognition") | null = null;
let available = false;

try {
  mod = require("expo-speech-recognition") as typeof import("expo-speech-recognition");
  // Probe whether the native module actually loaded
  mod.ExpoSpeechRecognitionModule.getPermissionsAsync;
  available = true;
} catch {
  available = false;
}

export const speechAvailable = available;

export const SpeechModule = available
  ? mod!.ExpoSpeechRecognitionModule
  : null;

export const useSpeechRecognitionEvent: typeof import("expo-speech-recognition")["useSpeechRecognitionEvent"] =
  available
    ? mod!.useSpeechRecognitionEvent
    : (() => {}) as any;
