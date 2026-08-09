import type { ComponentProps } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { SystemIcon } from './SystemIcon';
import { useMobileTheme } from './theme';

type EmptyStateIcon = Pick<ComponentProps<typeof SystemIcon>, 'android' | 'ios'>;

export function EmptyState({
  icon,
  iconColor,
  iconSize = 30,
  message,
  style,
}: {
  icon: EmptyStateIcon;
  iconColor?: string;
  iconSize?: number;
  message: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useMobileTheme();
  return (
    <View style={[styles.container, style]}>
      <View testID="empty-state-icon">
        <SystemIcon android={icon.android} color={iconColor || colors.textMuted} ios={icon.ios} size={iconSize} />
      </View>
      <Text style={[styles.message, { color: colors.textMuted }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: 10, justifyContent: 'center', padding: 24 },
  message: { fontSize: 15, lineHeight: 21, maxWidth: 300, textAlign: 'center' },
});
