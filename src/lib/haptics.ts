import * as Haptics from 'expo-haptics';

/** Light tap for selections and buttons. Never throws (no-op on devices/platforms without a motor). */
export function tap() {
  Haptics.selectionAsync().catch(() => {});
}

export function success() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}
