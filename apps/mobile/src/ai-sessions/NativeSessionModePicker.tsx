import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useMobileTheme } from '../components/theme';
import type { SessionDetailMode } from './SessionDetail';

export function NativeSessionModePicker({ mode, onChange }: { mode: SessionDetailMode; onChange(mode: SessionDetailMode): void }) {
  const { colors } = useMobileTheme();
  return (
    <View accessibilityRole="tablist" style={[styles.picker, { backgroundColor: colors.surfaceMuted }]}> 
      {(['conversation', 'turn'] as const).map((option) => (
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: mode === option }} key={option} onPress={() => onChange(option)} style={[styles.option, mode === option && { backgroundColor: colors.surface }]}>
          <Text style={[styles.text, { color: mode === option ? colors.text : colors.textMuted }]}>{option === 'conversation' ? 'Conversation' : 'Turn'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { borderRadius: 9, flexDirection: 'row', padding: 2 },
  option: { alignItems: 'center', borderRadius: 7, justifyContent: 'center', minHeight: 30, minWidth: 92, paddingHorizontal: 10 },
  text: { fontSize: 12, fontWeight: '600' },
});
