import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, TriangleAlert } from 'lucide-react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';

export function RetryWarning({ text }: { text: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const preview = text.split(/\r\n|\r|\n/, 1)[0] ?? '';

  return (
    <Pressable
      accessibilityLiveRegion="polite"
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={() => setExpanded((value) => !value)}
      style={({ pressed }) => [
        styles.container,
        { backgroundColor: colors.notice, borderColor: colors.sessionWaiting },
        pressed && styles.pressed,
      ]}
      testID="session-retry-warning"
    >
      <TriangleAlert color={colors.noticeText} size={18} style={styles.warningIcon} />
      <View style={styles.copy}>
        <Text style={[styles.title, { color: colors.noticeText }]}>{t('sessions.retryWarning')}</Text>
        {expanded
          ? <Text selectable style={[styles.detail, { color: colors.text }]} testID="session-retry-warning-detail">{text}</Text>
          : <Text numberOfLines={1} style={[styles.preview, { color: colors.text }]} testID="session-retry-warning-preview">{preview}</Text>}
      </View>
      <ChevronRight color={colors.noticeText} size={16} style={[styles.chevron, expanded && styles.chevronExpanded]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'flex-start', borderRadius: 8, borderWidth: 1, flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  pressed: { opacity: 0.78 },
  warningIcon: { flexShrink: 0, marginTop: 1 },
  copy: { flex: 1, gap: 6, minWidth: 0 },
  title: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  preview: { fontSize: 13, fontWeight: '400', lineHeight: 20 },
  detail: { fontSize: 13, fontWeight: '400', lineHeight: 20 },
  chevron: { flexShrink: 0, marginTop: 1 },
  chevronExpanded: { transform: [{ rotate: '90deg' }] },
});
