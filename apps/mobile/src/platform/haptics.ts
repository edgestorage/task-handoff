import * as Haptics from 'expo-haptics';

function ignoreUnavailableHaptics(result: Promise<void>) {
  void result.catch(() => undefined);
}

export function selectionHaptic() {
  ignoreUnavailableHaptics(Haptics.selectionAsync());
}

export function successHaptic() {
  ignoreUnavailableHaptics(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

export function errorHaptic() {
  ignoreUnavailableHaptics(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}
