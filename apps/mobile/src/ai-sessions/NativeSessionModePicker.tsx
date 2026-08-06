import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { SessionDetailMode } from './SessionDetail';

export function NativeSessionModePicker({ mode, onChange }: { mode: SessionDetailMode; onChange(mode: SessionDetailMode): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return (
    <View accessibilityRole="tablist" style={[styles.picker, { backgroundColor: colors.surfaceMuted }]}> 
      {(['conversation', 'turn'] as const).map((option) => (
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: mode === option }} key={option} onPress={() => onChange(option)} style={[styles.option, mode === option && { backgroundColor: colors.surface }]}>
          <Text style={[styles.text, { color: mode === option ? colors.text : colors.textMuted }]}>{option === 'conversation' ? t('sessions.conversation') : t('sessions.turn')}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { borderRadius: 10, flexDirection: 'row', padding: 2 },
  option: { alignItems: 'center', borderRadius: 8, justifyContent: 'center', minHeight: 32, minWidth: 96, paddingHorizontal: 12 },
  text: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
});
