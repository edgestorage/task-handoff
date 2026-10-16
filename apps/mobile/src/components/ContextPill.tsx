import { Pressable, StyleSheet, Text } from 'react-native';
import { Icon, type IconName } from './Icon';
import { useMobileTheme } from './theme';

export function ContextPill({ disabled, icon, label, onPress }: { disabled?: boolean; icon: IconName; label: string; onPress?: () => void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.contextPill, { backgroundColor: colors.surfaceMuted }, disabled && styles.disabled, pressed && styles.pressed]}>
    <Icon color={colors.textMuted} name={icon} size={15} />
    <Text numberOfLines={1} style={[styles.contextLabel, { color: colors.text }]}>{label}</Text>
    <Icon color={colors.textMuted} name="chevron-down" size={11} />
  </Pressable>;
}

const styles = StyleSheet.create({
  contextPill: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 6, maxWidth: '100%', minHeight: 38, paddingHorizontal: 11 },
  contextLabel: { flexShrink: 1, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
});
