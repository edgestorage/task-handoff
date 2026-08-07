import { StyleSheet, View } from 'react-native';
import type { AiSessionStatusGroup } from '@task-handoff/control-plane-client';

import { useMobileTheme, type MobileThemeColors } from '../components/theme';

export function sessionStatusTone(group: AiSessionStatusGroup, colors: MobileThemeColors) {
  if (group === 'active') return { foreground: colors.sessionActive, background: colors.sessionActiveSoft };
  if (group === 'waiting') return { foreground: colors.sessionWaiting, background: colors.sessionWaitingSoft };
  if (group === 'problem') return { foreground: colors.error, background: colors.errorSoft };
  return { foreground: colors.sessionIdle, background: colors.sessionIdleSoft };
}

export function SessionStatusIndicator({ group, label }: { group: AiSessionStatusGroup; label: string }) {
  const { colors } = useMobileTheme();
  const tone = sessionStatusTone(group, colors);
  return (
    <View accessibilityLabel={label} style={[styles.halo, { backgroundColor: tone.background }]}>
      <View style={[styles.dot, { backgroundColor: tone.foreground }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  halo: { alignItems: 'center', borderRadius: 7, height: 14, justifyContent: 'center', width: 14 },
  dot: { borderRadius: 4, height: 8, width: 8 },
});
