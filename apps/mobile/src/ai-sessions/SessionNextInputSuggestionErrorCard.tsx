import { ChevronRight, TriangleAlert } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { mobileWebType } from '../components/mobile-web-typography';
import { useI18n } from '../i18n';

export function SessionNextInputSuggestionErrorCard({
  message,
  onOpen,
}: {
  message: string;
  onOpen(): void;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityHint={t('suggestion.errorHint')}
      accessibilityLabel={t('suggestion.errorLabel')}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.card, { backgroundColor: colors.errorSoft, borderColor: colors.error }, pressed && styles.pressed]}
      testID="session-next-input-suggestion-error"
    >
      <TriangleAlert color={colors.error} size={16} strokeWidth={1.8} style={styles.icon} />
      <View style={styles.copy}>
        <Text style={[styles.label, { color: colors.error }]}>{t('suggestion.errorLabel')}</Text>
        <Text numberOfLines={2} style={[styles.message, { color: colors.text }]}>{message}</Text>
      </View>
      <ChevronRight color={colors.error} size={16} strokeWidth={1.8} style={styles.chevron} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'flex-start', borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, minHeight: 44, paddingHorizontal: 11, paddingVertical: 9 },
  icon: { flexShrink: 0, marginTop: 1 },
  copy: { flex: 1, gap: 2, minWidth: 0 },
  label: { fontSize: mobileWebType.small, fontWeight: '500', lineHeight: mobileWebType.smallLine },
  message: { fontSize: mobileWebType.meta, lineHeight: mobileWebType.metaLine },
  chevron: { alignSelf: 'center', flexShrink: 0 },
  pressed: { opacity: 0.65 },
});
