import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { mobileWebType } from './mobile-web-typography';
import { useMobileTheme } from './theme';

export function LoadingState({
  accessibilityLabel,
  description,
  style,
  testID,
  title,
}: {
  accessibilityLabel?: string;
  description: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title: string;
}) {
  const { colors } = useMobileTheme();
  return (
    <View accessibilityState={{ busy: true }} style={[styles.container, style]} testID={testID}>
      <ActivityIndicator accessibilityLabel={accessibilityLabel} color={colors.primary} />
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.description, { color: colors.textMuted }]}>{description}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 32 },
  title: { fontSize: 17, fontWeight: '700', lineHeight: 22, textAlign: 'center' },
  description: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine, maxWidth: 300, textAlign: 'center' },
});
