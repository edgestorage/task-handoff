import { Pressable, StyleSheet, Text } from 'react-native';

import { SystemIcon } from './SystemIcon';
import { useMobileTheme } from './theme';
import type { NativeActionButtonProps } from './NativeActionButton.ios';

export function NativeActionButton({ compact, destructive, disabled, icon, label, onPress }: NativeActionButtonProps) {
  const { colors } = useMobileTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, compact && styles.compact, { backgroundColor: destructive ? colors.errorSoft : colors.primaryButton }, disabled && styles.disabled, pressed && styles.pressed]}>
      {icon ? <SystemIcon android={icon.android} color={destructive ? colors.error : '#ffffff'} ios={icon.ios} size={16} /> : null}
      <Text style={[styles.text, destructive && { color: colors.error }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 48, paddingHorizontal: 16 },
  compact: { alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: 14 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
  text: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
