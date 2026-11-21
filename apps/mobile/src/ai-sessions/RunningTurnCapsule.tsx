import { Pressable, StyleSheet, Text } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { mobileWebType } from '../components/mobile-web-typography';
import { SessionStatusIndicator } from './SessionStatusIndicator';

export function RunningTurnCapsule({ label, onPress }: { label: string; onPress(): void }) {
  const { colors } = useMobileTheme();
  return <Pressable
    accessibilityLabel={label}
    accessibilityRole="button"
    onPress={onPress}
    style={({ pressed }) => [
      styles.capsule,
      { backgroundColor: colors.surface, borderColor: colors.border },
      pressed && styles.pressed,
    ]}
    testID="session-latest-running-capsule"
  >
    <SessionStatusIndicator group="active" label={label} size={14} />
    <Text numberOfLines={1} style={[styles.label, { color: colors.textMuted }]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  capsule: {
    alignItems: 'center',
    alignSelf: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 7,
    maxWidth: 360,
    marginBottom: 8,
    minHeight: 32,
    paddingLeft: 9,
    paddingRight: 12,
    shadowColor: '#000000',
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
  },
  label: {
    flexShrink: 1,
    fontSize: mobileWebType.small,
    fontWeight: '400',
    lineHeight: mobileWebType.smallLine,
  },
  pressed: { opacity: 0.68 },
});
