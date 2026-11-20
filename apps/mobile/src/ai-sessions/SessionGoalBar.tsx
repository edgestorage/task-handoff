import { Pause, Pencil, Play, Target, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AiSessionGoal } from '@task-handoff/protocol/ai-sessions';

import { useI18n, type Translate } from '../i18n';
import { useMobileTheme, type MobileThemeColors } from '../components/theme';
import { mobileWebMetric, mobileWebType } from '../components/mobile-web-typography';
import type { MobileAiSessionGoalCommand } from './actions';

const statusKeys = {
  active: 'sessions.goal.status.active',
  paused: 'sessions.goal.status.paused',
  blocked: 'sessions.goal.status.blocked',
  usageLimited: 'sessions.goal.status.usageLimited',
  budgetLimited: 'sessions.goal.status.budgetLimited',
  complete: 'sessions.goal.status.complete',
} as const;

export function aiSessionGoalStatusColor(status: AiSessionGoal['status'], colors: MobileThemeColors) {
  if (status === 'active') return colors.sessionActive;
  if (status === 'paused' || status === 'usageLimited') return colors.sessionWaiting;
  if (status === 'blocked' || status === 'budgetLimited') return colors.error;
  return colors.sessionIdle;
}

export function formatSessionGoalDuration(seconds: number, t: Translate) {
  const normalized = Math.max(0, Math.floor(seconds));
  if (!normalized) return '';
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const remainingSeconds = normalized % 60;
  return [
    hours ? t('sessions.goal.hours', { count: hours }) : '',
    minutes ? t('sessions.goal.minutes', { count: minutes }) : '',
    remainingSeconds ? t('sessions.goal.seconds', { count: remainingSeconds }) : '',
  ].filter(Boolean).join(' ');
}

export function SessionGoalBar({
  disabled = false,
  goal,
  onCommand,
  onEdit,
}: {
  disabled?: boolean;
  goal: AiSessionGoal;
  onCommand(command: MobileAiSessionGoalCommand): void;
  onEdit(): void;
}) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const canResume = goal.status !== 'active';
  const statusLabel = t(statusKeys[goal.status]);
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  const tokens = goal.tokenBudget === null
    ? t('sessions.goal.tokenUsage', { used: number(goal.tokensUsed) })
    : t('sessions.goal.budgetUsage', { used: number(goal.tokensUsed), budget: number(goal.tokenBudget) });
  const usageLabel = [tokens, formatSessionGoalDuration(goal.timeUsedSeconds, t)].filter(Boolean).join(' · ');

  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="session-goal">
    <View style={styles.header}>
      <View style={styles.title}>
        <Target color={colors.primary} size={mobileWebMetric(14)} />
        <Text style={[styles.label, { color: colors.text }]}>{t('sessions.goal.label')}</Text>
        <View style={styles.status}>
          <View style={[styles.statusDot, { backgroundColor: aiSessionGoalStatusColor(goal.status, colors) }]} />
          <Text numberOfLines={1} style={[styles.statusText, { color: colors.textMuted }]}>{statusLabel}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel={t('sessions.goal.edit')}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          hitSlop={5}
          onPress={onEdit}
          style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}
          testID="session-goal-edit"
        >
          <Pencil color={colors.primary} size={mobileWebMetric(14)} />
        </Pressable>
        <Pressable
          accessibilityLabel={t(canResume ? 'sessions.goal.resume' : 'sessions.goal.pause')}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          hitSlop={5}
          onPress={() => onCommand(canResume ? 'resume' : 'pause')}
          style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}
          testID={canResume ? 'session-goal-resume' : 'session-goal-pause'}
        >
          {canResume
            ? <Play color={colors.primary} size={mobileWebMetric(14)} />
            : <Pause color={colors.primary} size={mobileWebMetric(14)} />}
        </Pressable>
        <Pressable
          accessibilityLabel={t('sessions.goal.clear')}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          hitSlop={5}
          onPress={() => onCommand('clear')}
          style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}
          testID="session-goal-clear"
        >
          <Trash2 color={colors.error} size={mobileWebMetric(14)} />
        </Pressable>
      </View>
    </View>
    <Pressable
      accessibilityHint={t(expanded ? 'sessions.goal.hideDetails' : 'sessions.goal.showDetails')}
      accessibilityLabel={`${t('sessions.goal.label')}: ${goal.objective}. ${statusLabel}. ${usageLabel}`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={() => setExpanded((value) => !value)}
      testID="session-goal-objective"
    >
      <View style={styles.detailRow} testID="session-goal-detail">
        <Text numberOfLines={expanded ? undefined : 1} style={[styles.objective, { color: colors.text }]}>{goal.objective}</Text>
        <Text numberOfLines={1} style={[styles.usage, { color: colors.textMuted }]} testID="session-goal-usage">{usageLabel}</Text>
      </View>
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 4, paddingHorizontal: 10, paddingVertical: 8 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 32 },
  title: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 6, minWidth: 0 },
  label: { flexShrink: 0, fontSize: mobileWebType.small, fontWeight: '500', lineHeight: mobileWebType.smallLine },
  status: { alignItems: 'center', flexDirection: 'row', flexShrink: 1, gap: 5, minWidth: 0 },
  statusDot: { borderRadius: 3, height: 6, width: 6 },
  statusText: { flexShrink: 1, fontSize: mobileWebType.small, fontWeight: '500', lineHeight: mobileWebType.smallLine },
  actions: { alignItems: 'center', flexDirection: 'row', flexShrink: 0, gap: 2 },
  action: { alignItems: 'center', borderRadius: 8, height: 32, justifyContent: 'center', width: 32 },
  detailRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 8, minWidth: 0 },
  objective: { flex: 1, fontSize: mobileWebType.meta, fontWeight: '400', lineHeight: mobileWebType.metaLine, minWidth: 0 },
  usage: { flexShrink: 0, fontSize: mobileWebType.small, fontVariant: ['tabular-nums'], lineHeight: mobileWebType.smallLine },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.65 },
});
