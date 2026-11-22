import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PixelRatio, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { AiSessionTimelineActivity } from '@task-handoff/protocol/ai-sessions';
import { aiSessionActivityDetailInput, aiSessionFileChanges, localizedAiSessionActivityTitle, parseAiSessionDiff, type AiSessionFileChange } from '@task-handoff/control-plane-client';
import {
  Bot,
  BookOpen,
  Brain,
  Check,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  Copy,
  FilePenLine,
  FileSearch,
  FolderOpen,
  Image as ImageIcon,
  ListTodo,
  ListTree,
  Minimize2,
  Download,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n, type Translate } from '../i18n';
import { mobileWebMetric, mobileWebType } from '../components/mobile-web-typography';
import { CodeDiffRows } from '../repository/RepositoryDiffView';
import { sourceLanguageForPath } from '../repository/sourceLanguage';
import { AnimatedDisclosure, DisclosureChevron, DisclosureChevronDown } from './AnimatedDisclosure';

const maxFileDiffPreviewLines = 300;

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
  const summaryAvailable = summaryVisible && activities.length > 1;
  const activityList = <View style={styles.activityList} testID="timeline-activity-list">{activities.map((activity) => (
    <TimelineActivity key={activity.id} activity={activity} />
  ))}</View>;
  if (!summaryAvailable) return activityList;
  const latest = activities.at(-1)!;
  return (
    <View style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.groupHeader}
      >
        <View testID="timeline-activity-group-icon"><ListTree color={colors.textMuted} size={mobileWebMetric(15)} /></View>
        <Text style={[styles.groupTitle, { color: colors.textMuted }]}>{t('sessions.timelineActivityCount', { count: activities.length })}</Text>
        <Text numberOfLines={1} style={[styles.groupLatest, { color: colors.textMuted }]}>· {activitySummary(latest) || activityLabel(latest, t)}</Text>
        <DisclosureChevronDown color={colors.textMuted} expanded={expanded} size={mobileWebMetric(15)} />
      </Pressable>
      <AnimatedDisclosure expanded={expanded}>{activityList}</AnimatedDisclosure>
    </View>
  );
}

function TimelineActivity({ activity }: { activity: AiSessionTimelineActivity }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const isFileChange = activity.activityKind === 'fileChange';
  const input = aiSessionActivityDetailInput(activity);
  const hasDetails = Boolean(input || activity.output || activity.exitCode !== undefined || (isFileChange && activity.paths?.length));
  const [expanded, setExpanded] = useState(false);
  const failed = activity.status === 'failed';
  const ActivityIcon = timelineActivityIcon(activity.activityKind);
  const title = activity.activityKind === 'commandExecution'
    ? t(`sessions.timelineCommand.${activity.status || 'unknown'}` as 'sessions.timelineCommand.unknown')
    : localizedAiSessionActivityTitle(activity, t);
  const status = activity.activityKind !== 'commandExecution' && (activity.status === 'running' || activity.status === 'failed')
    ? t(`sessions.timelineStatus.${activity.status}` as 'sessions.timelineStatus.running')
    : undefined;
  const content = <>
    {ActivityIcon ? createElement(ActivityIcon, { color: failed ? colors.error : colors.textMuted, size: mobileWebMetric(15), style: styles.activityKindIcon })
      : hasDetails ? <DisclosureChevron color={failed ? colors.error : colors.textMuted} expanded={expanded} size={mobileWebMetric(15)} style={styles.activityKindIcon} />
        : null}
    <Text style={[styles.activityTitle, { color: failed ? colors.error : colors.textMuted }]}>{title}</Text>
    {activitySummary(activity) ? <Text numberOfLines={1} style={[styles.activitySummary, { color: colors.textMuted }]}>· {activitySummary(activity)}</Text> : null}
    {status ? <Text style={[styles.activityStatus, { color: failed ? colors.error : colors.textMuted }]}>{status}</Text> : null}
    {ActivityIcon && hasDetails ? <DisclosureChevron color={colors.textMuted} expanded={expanded} size={mobileWebMetric(15)} /> : null}
  </>;
  return <View style={styles.activity}>
    {hasDetails ? <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={styles.activityHeader}>{content}</Pressable>
      : <View style={styles.activityHeader}>{content}</View>}
    <AnimatedDisclosure expanded={expanded} spacing={mobileWebMetric(7)}><View style={[styles.details, { borderTopColor: colors.border }]}>
      {activity.activityKind === 'commandExecution'
        ? <TimelineCommandResult command={activity.input} exitCode={activity.exitCode} output={activity.output} />
        : isFileChange ? <TimelineFileChanges activity={activity} />
          : <TimelineTextResult title={title} input={input} output={activity.output} exitCode={activity.exitCode} />}
    </View></AnimatedDisclosure>
  </View>;
}

function TimelineCommandResult({ command, exitCode, output }: { command?: string; exitCode?: number; output?: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const commandLine = command ? `$ ${command}` : '';
  const outputText = output || '';
  const content = [commandLine, outputText].filter(Boolean).join('\n');
  return <TimelineResultCard>
    <TimelineResultHeader title={t('sessions.timelineCommandShell')} exitCode={exitCode === 0 ? undefined : exitCode} content={content} copyLabel={t('sessions.timelineCopyOutput')} />
    {content
      ? <TimelineResultText content={content} testID="timeline-command-result">
        {commandLine ? <Text testID="timeline-command-input" style={{ color: colors.textMuted }}>{commandLine}</Text> : null}
        {outputText ? <Text testID="timeline-command-output" style={{ color: colors.text }}>{`${commandLine ? '\n' : ''}${outputText}`}</Text> : null}
      </TimelineResultText>
      : <Text style={[styles.resultEmpty, { color: colors.textMuted }]}>{t('sessions.timelineNoCommandOutput')}</Text>}
  </TimelineResultCard>;
}

function TimelineResultCard({ children }: { children: ReactNode }) {
  const { colors } = useMobileTheme();
  return <View style={[styles.resultCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>;
}

function TimelineResultHeader({ title, exitCode, content, copyLabel, touchSized }: {
  title: string; exitCode?: number; content: string; copyLabel: string; touchSized?: boolean;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <View style={[styles.resultHeader, { borderBottomColor: colors.border }]}>
    <Text numberOfLines={2} style={[styles.resultHeaderText, styles.resultTitle, { color: colors.textMuted }]}>{title}</Text>
    {exitCode !== undefined ? <Text style={[styles.resultHeaderText, { color: exitCode === 0 ? colors.textMuted : colors.error }]}>{t('sessions.timelineExitCode', { code: exitCode })}</Text> : null}
    {content ? <TimelineCopyButton content={content} label={copyLabel} touchSized={touchSized} /> : null}
  </View>;
}

function TimelineResultText({ content, children, testID }: { content: string; children?: ReactNode; testID?: string }) {
  const { colors } = useMobileTheme();
  const contentHeight = Math.ceil(
    content.split('\n').length * mobileWebMetric(12 * 1.55) * PixelRatio.getFontScale()
      + mobileWebMetric(9) + mobileWebMetric(18),
  );
  return <ScrollView nestedScrollEnabled style={styles.resultBody} testID={testID}>
    <ScrollView contentContainerStyle={styles.resultContent} horizontal showsHorizontalScrollIndicator={false} style={{ height: contentHeight }} testID={testID ? `${testID}-content` : undefined}>
      <Text selectable style={[styles.resultText, { color: colors.text }]}>{children ?? content}</Text>
    </ScrollView>
  </ScrollView>;
}

function TimelineFileChanges({ activity }: { activity: AiSessionTimelineActivity }) {
  const changes = useMemo(() => aiSessionFileChanges(activity), [activity]);
  const { t } = useI18n();
  if (!changes.length && (activity.input || activity.output || activity.exitCode !== undefined)) {
    return <TimelineTextResult title={activityLabel(activity, t)} input={activity.input} output={activity.output} exitCode={activity.exitCode} />;
  }
  const files = changes.length ? changes : (activity.paths ?? []).map((path) => ({ path, diff: '' }));
  return <TimelineResultCard>
    {files.map((change, index) => <TimelineFileChange change={change} divided={index > 0} key={JSON.stringify([change.path, index])} />)}
  </TimelineResultCard>;
}

function TimelineFileChange({ change, divided }: { change: AiSessionFileChange; divided: boolean }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => parseAiSessionDiff(change.diff), [change.diff]);
  const path = change.movePath ? `${change.path} → ${change.movePath}` : change.path;
  const additions = lines.filter((line) => line.kind === 'addition').length;
  const deletions = lines.filter((line) => line.kind === 'deletion').length;
  return <View style={divided && [styles.fileChangeDivider, { borderColor: colors.border }]}>
    <View style={styles.fileChangeHeader}>
      <Pressable accessibilityLabel={path} accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={({ pressed }) => [styles.fileChangeToggle, pressed && styles.pressed]}>
        <DisclosureChevron color={colors.textMuted} expanded={expanded} size={mobileWebMetric(15)} />
        <Text ellipsizeMode="middle" numberOfLines={2} style={[styles.resultHeaderText, styles.filePath, { color: colors.text }]}>{path}</Text>
        {additions ? <Text style={[styles.resultHeaderText, { color: colors.sessionActive }]}>+{additions}</Text> : null}
        {deletions ? <Text style={[styles.resultHeaderText, { color: colors.error }]}>-{deletions}</Text> : null}
      </Pressable>
      {change.diff ? <TimelineCopyButton content={change.diff} label={t('sessions.timelineCopyDiff', { path })} touchSized /> : null}
    </View>
    <AnimatedDisclosure expanded={expanded}>
      <View style={[styles.fileChangeDivider, { borderColor: colors.border }]}>
        {lines.length ? <>
          <ScrollView nestedScrollEnabled style={styles.fileDiffBody}>
            <CodeDiffRows colors={colors} language={sourceLanguageForPath(change.movePath ?? change.path)} rows={lines.slice(0, maxFileDiffPreviewLines)} />
          </ScrollView>
          {lines.length > maxFileDiffPreviewLines ? <Text style={[styles.resultEmpty, { color: colors.textMuted }]}>{t('sessionResources.diff.truncatedLines', { count: maxFileDiffPreviewLines })}</Text> : null}
        </> : change.diff
          ? <TimelineResultText content={change.diff} />
          : <Text style={[styles.resultEmpty, { color: colors.textMuted }]}>{t('sessionResources.diff.noText')}</Text>}
      </View>
    </AnimatedDisclosure>
  </View>;
}

function TimelineCopyButton({ content, label, touchSized }: { content: string; label: string; touchSized?: boolean }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(content);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1_500);
  };
  return <Pressable accessibilityLabel={copied ? t('sessions.codeCopied') : label} accessibilityRole="button" hitSlop={touchSized ? undefined : 6} onPress={() => void copy()} style={({ pressed }) => [styles.resultCopy, touchSized && styles.resultCopyTouch, pressed && styles.pressed]}>
    {copied ? <Check color={colors.textMuted} size={mobileWebMetric(14)} /> : <Copy color={colors.textMuted} size={mobileWebMetric(14)} />}
  </Pressable>;
}

function TimelineTextResult({ title, input, output, exitCode }: { title: string; input?: string; output?: string; exitCode?: number }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const content = [input, output].filter(Boolean).join('\n\n');
  const inputLabel = t('sessions.timelineInput');
  const outputLabel = t('sessions.timelineOutput');
  return <TimelineResultCard>
    <TimelineResultHeader title={title} exitCode={exitCode} content={content} copyLabel={t('sessions.timelineCopyDetails')} touchSized />
    {input && output ? <TimelineResultText content={`${inputLabel}\n${input}\n\n${outputLabel}\n${output}`} testID="timeline-text-result">
      <Text style={{ color: colors.textMuted }}>{inputLabel}</Text>{'\n'}<Text>{input}</Text>{'\n\n'}
      <Text style={{ color: colors.textMuted }}>{outputLabel}</Text>{'\n'}<Text>{output}</Text>
    </TimelineResultText> : content ? <TimelineResultText content={content} testID="timeline-text-result" /> : null}
  </TimelineResultCard>;
}

function activitySummary(activity: AiSessionTimelineActivity) {
  if (activity.activityKind === 'commandExecution') return activity.input?.trim() || '';
  if (activity.activityKind === 'fileChange' && activity.paths?.length) return activity.paths.map(runtimePathBasename).join(', ');
  return activity.summary || activity.paths?.join(', ') || '';
}

function activityLabel(activity: AiSessionTimelineActivity, t: Translate) {
  return activity.activityKind === 'commandExecution'
    ? t(`sessions.timelineCommand.${activity.status || 'unknown'}` as 'sessions.timelineCommand.unknown')
    : localizedAiSessionActivityTitle(activity, t);
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
  if (kind === 'fileRead') return BookOpen;
  if (kind === 'fileSearch') return FileSearch;
  if (kind === 'fileList') return FolderOpen;
  if (kind === 'explore') return Search;
  if (kind === 'webFetch') return Download;
  if (kind === 'todoUpdate') return ListTodo;
  if (kind === 'userQuestion') return CircleHelp;
  if (kind === 'skillLoad') return Brain;
  if (kind === 'exitedPlanMode') return ClipboardCheck;
  return undefined;
}

const styles = StyleSheet.create({
  group: { gap: mobileWebMetric(6), minWidth: 0 },
  groupHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(5), minHeight: mobileWebType.bodyLine },
  groupTitle: { fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  groupLatest: { flex: 1, fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  activityList: { gap: mobileWebMetric(6) },
  activity: { minWidth: 0 },
  activityHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(5), minHeight: mobileWebType.bodyLine },
  activityKindIcon: { flexShrink: 0 },
  activityTitle: { fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  activitySummary: { flex: 1, fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  activityStatus: { fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine, marginLeft: 'auto' },
  details: { borderTopWidth: StyleSheet.hairlineWidth, gap: mobileWebMetric(8), paddingTop: mobileWebMetric(7) },
  resultCard: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, minWidth: 0, overflow: 'hidden' },
  resultHeader: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: mobileWebMetric(6), minHeight: mobileWebMetric(30), paddingLeft: mobileWebMetric(10), paddingRight: mobileWebMetric(6) },
  resultHeaderText: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine },
  resultTitle: { flexShrink: 1, minWidth: 0 },
  resultCopy: { alignItems: 'center', borderRadius: mobileWebMetric(4), height: mobileWebMetric(24), justifyContent: 'center', marginLeft: 'auto', width: mobileWebMetric(24) },
  resultCopyTouch: { height: Platform.OS === 'android' ? 48 : 44, width: Platform.OS === 'android' ? 48 : 44 },
  resultBody: { maxHeight: mobileWebMetric(320), minWidth: 0 },
  resultContent: { paddingBottom: mobileWebMetric(18), paddingHorizontal: mobileWebMetric(12), paddingTop: mobileWebMetric(9) },
  resultText: { fontFamily: 'monospace', fontSize: mobileWebType.small, lineHeight: mobileWebMetric(12 * 1.55) },
  resultEmpty: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine, paddingHorizontal: mobileWebMetric(11), paddingVertical: mobileWebMetric(13) },
  fileChangeHeader: { alignItems: 'center', flexDirection: 'row' },
  fileChangeDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  fileChangeToggle: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: mobileWebMetric(6), minHeight: Platform.OS === 'android' ? 48 : 44, paddingHorizontal: mobileWebMetric(10) },
  filePath: { flex: 1, minWidth: 0 },
  fileDiffBody: { maxHeight: mobileWebMetric(300) },
  pressed: { opacity: 0.65 },
});
