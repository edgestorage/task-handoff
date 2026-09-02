import { Pressable, StyleSheet, Text } from 'react-native';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { SystemIcon } from './SystemIcon';
import { useMobileTheme } from './theme';

export function ContextPill({ disabled, icon, label, onPress }: { disabled?: boolean; icon: { android: AndroidSymbol; ios: SFSymbol }; label: string; onPress?: () => void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.contextPill, { backgroundColor: colors.surfaceMuted }, disabled && styles.disabled, pressed && styles.pressed]}>
    <SystemIcon android={icon.android} color={colors.textMuted} ios={icon.ios} size={15} />
    <Text numberOfLines={1} style={[styles.contextLabel, { color: colors.text }]}>{label}</Text>
    <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={11} />
  </Pressable>;
}

const styles = StyleSheet.create({
  contextPill: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 6, maxWidth: '100%', minHeight: 38, paddingHorizontal: 11 },
  contextLabel: { flexShrink: 1, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
});
