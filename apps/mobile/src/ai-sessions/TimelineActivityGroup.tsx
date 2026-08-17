import { createElement, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AiSessionTimelineActivity } from '@task-handoff/protocol/ai-sessions';
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  FilePenLine,
  Image as ImageIcon,
  ListTodo,
  Minimize2,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { mobileWebMetric, mobileWebType } from '../components/mobile-web-typography';

export function TimelineActivityGroup({
  activities,
  summaryVisible = true,
}: {
  activities: readonly AiSessionTimelineActivity[];
  summaryVisible?: boolean;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!activities.length) return null;
  const activityList = <View style={[styles.activityList, !summaryVisible && styles.activityListInline]}>{activities.map((activity) => (
    <TimelineActivity key={activity.id} activity={activity} />
  ))}</View>;
  if (!summaryVisible) return activityList;
  const latest = activities.at(-1)!;
  return (
    <View style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.groupHeader}
      >
        {expanded ? <ChevronDown color={colors.textMuted} size={mobileWebMetric(15)} /> : <ChevronRight color={colors.textMuted} size={mobileWebMetric(15)} />}
        <Text style={[styles.groupTitle, { color: colors.textMuted }]}>{t('sessions.timelineActivityCount', { count: activities.length })}</Text>
        <Text numberOfLines={1} style={[styles.groupLatest, { color: colors.textMuted }]}>· {activitySummary(latest) || latest.title}</Text>
      </Pressable>
      {expanded ? activityList : null}
    </View>
  );
}

function TimelineActivity({ activity }: { activity: AiSessionTimelineActivity }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const hasDetails = Boolean(activity.input || activity.output || activity.exitCode !== undefined);
  const [expanded, setExpanded] = useState(false);
  const failed = activity.status === 'failed';
  const ActivityIcon = timelineActivityIcon(activity.activityKind);
  const title = activity.activityKind === 'commandExecution'
    ? t(`sessions.timelineCommand.${activity.status || 'unknown'}` as 'sessions.timelineCommand.unknown')
    : activity.title;
  const status = activity.activityKind !== 'commandExecution' && (activity.status === 'running' || activity.status === 'failed')
    ? t(`sessions.timelineStatus.${activity.status}` as 'sessions.timelineStatus.running')
    : undefined;
  const content = <>
    {ActivityIcon ? createElement(ActivityIcon, { color: failed ? colors.error : colors.textMuted, size: mobileWebMetric(14), style: styles.activityKindIcon })
      : hasDetails ? expanded
        ? <ChevronDown color={failed ? colors.error : colors.textMuted} size={mobileWebMetric(14)} style={styles.activityKindIcon} />
        : <ChevronRight color={failed ? colors.error : colors.textMuted} size={mobileWebMetric(14)} style={styles.activityKindIcon} />
        : null}
    <Text style={[styles.activityTitle, { color: failed ? colors.error : colors.textMuted }]}>{title}</Text>
    {activitySummary(activity) ? <Text numberOfLines={1} style={[styles.activitySummary, { color: colors.textMuted }]}>· {activitySummary(activity)}</Text> : null}
    {status ? <Text style={[styles.activityStatus, { color: failed ? colors.error : colors.textMuted }]}>{status}</Text> : null}
  </>;
  return <View style={styles.activity}>
    {hasDetails ? <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={styles.activityHeader}>{content}</Pressable>
      : <View style={styles.activityHeader}>{content}</View>}
    {expanded ? <View style={[styles.details, { borderTopColor: colors.border }]}>
      {activity.input ? <TimelineActivityDetail label={t('sessions.timelineInput')} text={activity.input} /> : null}
      {activity.output ? <TimelineActivityDetail label={t('sessions.timelineOutput')} text={activity.output} /> : null}
      {activity.exitCode !== undefined ? <Text style={[styles.detailLabel, { color: colors.textMuted }]}>{t('sessions.timelineExitCode', { code: activity.exitCode })}</Text> : null}
    </View> : null}
  </View>;
}

function TimelineActivityDetail({ label, text }: { label: string; text: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.detailSection}>
    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>{label}</Text>
    <ScrollView nestedScrollEnabled style={[styles.detailScroll, { borderLeftColor: colors.border }]}>
      <Text selectable style={[styles.detailText, { color: colors.text }]}>{text}</Text>
    </ScrollView>
  </View>;
}

function activitySummary(activity: AiSessionTimelineActivity) {
  if (activity.activityKind === 'commandExecution') return activity.input?.trim() || '';
  if (activity.activityKind === 'fileChange' && activity.paths?.length) return activity.paths.map(runtimePathBasename).join(', ');
  return activity.summary || activity.paths?.join(', ') || '';
}

function runtimePathBasename(path: string) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

export function timelineActivityIcon(kind: string): LucideIcon | undefined {
  if (kind === 'reasoning') return Brain;
  if (kind === 'plan') return ListTodo;
  if (kind === 'hookPrompt') return CircleHelp;
  if (kind === 'commandExecution') return SquareTerminal;
  if (kind === 'fileChange') return FilePenLine;
  if (kind === 'mcpToolCall') return Plug;
  if (kind === 'dynamicToolCall') return Wrench;
  if (kind === 'collabAgentToolCall') return Users;
  if (kind === 'subAgentActivity') return Bot;
  if (kind === 'webSearch') return Search;
  if (kind === 'imageView') return ImageIcon;
  if (kind === 'sleep') return Clock3;
  if (kind === 'imageGeneration') return Sparkles;
  if (kind === 'enteredReviewMode' || kind === 'exitedReviewMode') return ClipboardCheck;
  if (kind === 'contextCompaction') return Minimize2;
  return undefined;
}

const styles = StyleSheet.create({
  group: { gap: mobileWebMetric(8), minWidth: 0 },
  groupHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(5), minHeight: mobileWebType.bodyLine },
  groupTitle: { fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  groupLatest: { flex: 1, fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  activityList: { gap: mobileWebMetric(6), marginLeft: mobileWebMetric(20) },
  activityListInline: { marginLeft: 0 },
  activity: { gap: mobileWebMetric(5), minWidth: 0 },
  activityHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(5), minHeight: mobileWebType.bodyLine },
  activityKindIcon: { flexShrink: 0 },
  activityTitle: { fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  activitySummary: { flex: 1, fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  activityStatus: { fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine, marginLeft: 'auto' },
  details: { borderTopWidth: StyleSheet.hairlineWidth, gap: mobileWebMetric(8), marginTop: mobileWebMetric(2), paddingTop: mobileWebMetric(7) },
  detailSection: { gap: mobileWebMetric(4) },
  detailLabel: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine },
  detailScroll: { borderLeftWidth: StyleSheet.hairlineWidth, maxHeight: mobileWebMetric(280), paddingLeft: mobileWebMetric(10) },
  detailText: { fontFamily: 'monospace', fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine, paddingVertical: mobileWebMetric(7) },
});
