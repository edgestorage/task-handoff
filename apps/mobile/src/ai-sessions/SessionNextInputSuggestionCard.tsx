import { CornerDownRight, Sparkles, X } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { mobileWebType } from '../components/mobile-web-typography';
import { useI18n } from '../i18n';

export function SessionNextInputSuggestionCard({
  text,
  onUse,
  onDismiss,
}: {
  text: string;
  onUse(): void;
  onDismiss(): void;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="session-next-input-suggestion">
      <Pressable
        accessibilityHint={t('suggestion.useHint')}
        accessibilityLabel={t('suggestion.useLabel', { text })}
        accessibilityRole="button"
        onPress={onUse}
        style={({ pressed }) => [styles.use, pressed && styles.pressed]}
      >
        <View style={styles.heading}>
          <Sparkles color={colors.primary} size={14} strokeWidth={1.8} />
          <Text style={[styles.label, { color: colors.textMuted }]}>{t('suggestion.label')}</Text>
        </View>
        <Text numberOfLines={3} style={[styles.text, { color: colors.text }]}>{text}</Text>
        <View style={styles.useHint}>
          <CornerDownRight color={colors.textMuted} size={12} strokeWidth={1.8} />
          <Text style={[styles.useHintText, { color: colors.textMuted }]}>{t('suggestion.use')}</Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityLabel={t('suggestion.dismiss')}
        accessibilityRole="button"
        hitSlop={8}
        onPress={onDismiss}
        style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
      >
        <X color={colors.textMuted} size={16} strokeWidth={1.8} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'stretch', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', overflow: 'hidden' },
  use: { flex: 1, gap: 3, minHeight: 44, paddingBottom: 8, paddingHorizontal: 11, paddingTop: 8 },
  heading: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  label: { fontSize: mobileWebType.small, fontWeight: '500', lineHeight: mobileWebType.smallLine },
  text: { fontSize: mobileWebType.meta, lineHeight: mobileWebType.metaLine },
  useHint: { alignItems: 'center', flexDirection: 'row', gap: 4, marginTop: 2 },
  useHintText: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine },
  dismiss: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  pressed: { opacity: 0.65 },
});
