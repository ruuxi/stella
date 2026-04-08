import * as Haptics from "expo-haptics";

/** Light tap — mode switches, toggles, small confirmations. */
export const tapLight = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

/** Medium tap — send message, pair success. */
export const tapMedium = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

/** Success notification — pairing complete, connection established. */
export const notifySuccess = () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

/** Error notification — pairing failed, connection error. */
export const notifyError = () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
