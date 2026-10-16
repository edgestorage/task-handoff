import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from './Icon';
import { useMobileTheme } from './theme';

export function EmptyState({
  icon,
  iconColor,
  iconSize = 30,
  message,
  style,
}: {
  icon: IconName;
  iconColor?: string;
  iconSize?: number;
  message: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useMobileTheme();
  return (
    <View style={[styles.container, style]}>
      <View testID="empty-state-icon">
        <Icon color={iconColor || colors.textMuted} name={icon} size={iconSize} />
      </View>
      <Text style={[styles.message, { color: colors.textMuted }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: 10, justifyContent: 'center', padding: 24 },
  message: { fontSize: 15, lineHeight: 21, maxWidth: 300, textAlign: 'center' },
});
