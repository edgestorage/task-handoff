import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Crypto from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import type { Story, StoryAction, StoryAutomationRun, StoryAutomationSchedule, StoryAutomationStatus } from '@task-handoff/protocol/stories';
import { aiSessionStatusGroup } from '@task-handoff/control-plane-client';
import { directoryAiSessionProviderCapability } from '@task-handoff/protocol/control-plane-directory';

import { SessionStatusIndicator } from '../ai-sessions/SessionStatusIndicator';
import { mobileAiSessionStatusLabel } from '../ai-sessions/SessionDetail';
import { storyAiSessionCreationDefaults } from '../ai-sessions/new-session-types';
import { createMobileAiSession, lifecycleGuidance } from '../ai-sessions/session-lifecycle';
import { useActiveAiSessionsSnapshot } from '../ai-sessions/use-active-sessions';
import { EmptyState } from '../components/EmptyState';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { mobilePermissionStore } from '../control-plane/runtime';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n, type Translate } from '../i18n';

type AutomationView = StoryAutomationStatus & { recentRuns: StoryAutomationRun[] };
type StorySection = 'actions' | 'documents' | 'sessions' | 'automations';
const storySections: StorySection[] = ['actions', 'documents', 'sessions', 'automations'];

export function StoryDetail({ storyId, nodeId, onOpenSession }: { storyId?: string; nodeId?: string; onOpenSession(instanceId: string, sessionId: string): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const { controlPlaneId, state: directory } = useActiveDirectories();
  const sessions = useActiveAiSessionsSnapshot();
  const [story, setStory] = useState<Story>();
  const [automations, setAutomations] = useState<AutomationView[]>([]);
  const [error, setError] = useState<string>();
  const [automationError, setAutomationError] = useState('');
  const [loading, setLoading] = useState(true);
  const [runningActionId, setRunningActionId] = useState<string>();
  const [busyAutomationId, setBusyAutomationId] = useState<string>();
  const scrollRef = useRef<ScrollView>(null);
  const [sectionOffsets, setSectionOffsets] = useState<Partial<Record<StorySection, number>>>({});
  const [sectionNavHeight, setSectionNavHeight] = useState(0);
  const [activeSection, setActiveSection] = useState<StorySection>('actions');

  const loadAutomations = useCallback(async () => {
    if (!runtime.api || !storyId || !nodeId) return;
    const statuses = (await runtime.api.stories.listAutomations(storyId, nodeId)).automations;
    const values = await Promise.all(statuses.map(async (status): Promise<AutomationView> => ({
      ...status,
      recentRuns: (await runtime.api!.stories.automationRuns(storyId, status.automation.id, nodeId)).runs.slice(0, 3),
    })));
    setAutomations(values);
  }, [nodeId, runtime.api, storyId]);

  useFocusEffect(useCallback(() => {
    if (!runtime.api || !storyId || !nodeId) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    setAutomationError('');
    void Promise.all([runtime.api.stories.get(storyId, nodeId), runtime.api.stories.listAutomations(storyId, nodeId)]).then(async ([storyValue, list]) => {
      const values = await Promise.all(list.automations.map(async (status): Promise<AutomationView> => ({
        ...status,
        recentRuns: (await runtime.api!.stories.automationRuns(storyId, status.automation.id, nodeId)).runs.slice(0, 3),
      })));
      if (live) { setStory(storyValue); setAutomations(values); }
    }).catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [nodeId, runtime.api, storyId]));

  const nodeNames = useMemo(() => new Map(directory.nodes.map((node) => [node.id, node.name])), [directory.nodes]);
  const instanceNames = useMemo(() => new Map(directory.instances.map((item) => [item.id, item.name])), [directory.instances]);
  const storyNodeId = story?.ownerNodeId || nodeId || '';
  const storyInstanceIds = useMemo(() => new Set(directory.instances.filter((instance) => instance.nodeId === storyNodeId).map((instance) => instance.id)), [directory.instances, storyNodeId]);
  const linkedSessions = useMemo(() => (sessions?.instances ?? []).flatMap((instance) => instance.aiSessions.sessions.map((session) => ({ ...session, instanceId: instance.instanceId }))).filter((item) => storyInstanceIds.has(item.instanceId) && item.storyId === storyId), [sessions, storyId, storyInstanceIds]);
  const newSessionDefaults = useMemo(() => storyAiSessionCreationDefaults(directory.instances, sessions, storyId || '', storyNodeId), [directory.instances, sessions, storyId, storyNodeId]);
  const automationCount = (actionId: string) => automations.filter((entry) => entry.automation.actionId === actionId).length;
  const automationPath = (automationId: string) => ({ pathname: `/stories/${story!.id}/automations/${automationId}` as never, params: { storyId: story!.id, automationId, nodeId: story!.ownerNodeId } });

  const runAction = async (action: StoryAction) => {
    if (!runtime.api || !controlPlaneId || !story || runningActionId) return;
    const target = action.targetInstanceId
      ? directory.instances.find((instance) => instance.id === action.targetInstanceId)
      : directory.instances.find((instance) => instance.nodeId === story.ownerNodeId && instance.ready);
    if (!target) { Alert.alert(t('stories.actionFailed'), t('stories.noAvailableInstance')); return; }
    setRunningActionId(action.id);
    try {
      const preset = action.sessionPreset;
      const agent = preset?.agent ?? 'codex';
      const permissionMode = preset?.permissionMode ?? 'ask';
      const permissionModes = directoryAiSessionProviderCapability(target.capabilities, agent)?.permissionModes || [];
      const result = await createMobileAiSession(runtime.api, {
        instance: target,
        agent,
        clientRequestId: `story-action-${Crypto.randomUUID()}`,
        message: action.promptTemplate,
        permissionMode,
        mode: preset?.mode,
        cwdFolderId: preset?.cwdFolderId,
        gitSelection: preset?.gitSelection,
        modelSelection: preset?.modelSelection,
        reasoningEffort: preset?.reasoningEffort,
        storyId: story.id,
      });
      if (permissionModes.includes(permissionMode)) await mobilePermissionStore.write(controlPlaneId, target.id, result.aiSessionId, permissionMode).catch(() => undefined);
      onOpenSession(target.id, result.aiSessionId);
    } catch (cause) {
      Alert.alert(t('stories.actionFailed'), lifecycleGuidance(cause).message);
    } finally {
      setRunningActionId(undefined);
    }
  };
  const confirmAction = (action: StoryAction) => Alert.alert(t('stories.executeActionTitle', { name: action.title }), t('stories.executeActionDescription'), [{ text: t('common.cancel'), style: 'cancel' }, { text: t('stories.executeAction'), onPress: () => { void runAction(action); } }]);
  const mutateAutomation = async (automationId: string, operation: () => Promise<unknown>) => {
    setBusyAutomationId(automationId);
    setAutomationError('');
    try { await operation(); await loadAutomations(); } catch (cause) { setAutomationError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusyAutomationId(undefined); }
  };
  const confirmRunAutomation = (entry: AutomationView) => Alert.alert(t('stories.automationRunTitle'), t('stories.automationRunDescription'), [{ text: t('common.cancel'), style: 'cancel' }, { text: t('stories.automationRun'), onPress: () => { if (runtime.api && story) void mutateAutomation(entry.automation.id, () => runtime.api!.stories.runAutomation(story.id, entry.automation.id, story.ownerNodeId, { clientRequestId: `story-automation-${Crypto.randomUUID()}` })); } }]);
  const confirmDeleteAutomation = (entry: AutomationView) => Alert.alert(t('stories.automationDeleteTitle'), t('stories.automationDeleteDescription'), [{ text: t('common.cancel'), style: 'cancel' }, { text: t('common.remove'), style: 'destructive', onPress: () => { if (runtime.api && story) void mutateAutomation(entry.automation.id, () => runtime.api!.stories.removeAutomation(story.id, entry.automation.id, story.ownerNodeId)); } }]);
  const recordSectionOffset = useCallback((section: StorySection, event: LayoutChangeEvent) => {
    setSectionOffsets((current) => ({ ...current, [section]: event.nativeEvent.layout.y }));
  }, []);
  const updateActiveSection = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const position = event.nativeEvent.contentOffset.y + sectionNavHeight + 8;
    let next: StorySection = 'actions';
    for (const section of storySections) {
      const offset = sectionOffsets[section];
      if (offset !== undefined && offset <= position) next = section;
    }
    setActiveSection(next);
  }, [sectionNavHeight, sectionOffsets]);
  const scrollToSection = useCallback((section: StorySection) => {
    setActiveSection(section);
    const offset = sectionOffsets[section];
    if (offset !== undefined) scrollRef.current?.scrollTo({ animated: true, y: Math.max(0, offset - sectionNavHeight) });
  }, [sectionNavHeight, sectionOffsets]);

  if (loading && !story) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  if (!story) return <EmptyState icon={{ android: 'error_outline', ios: 'exclamationmark.circle' }} iconColor={colors.error} message={error || t('stories.loadError')} style={styles.errorState} />;
  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.content, { backgroundColor: colors.background }]} onScroll={updateActiveSection} ref={scrollRef} scrollEventThrottle={16} stickyHeaderIndices={[1]}>
    <View style={styles.header}><View style={styles.titleRow}><Text style={[styles.title, { color: colors.text }]}>{story.title}</Text><Pressable accessibilityLabel={t('stories.edit')} onPress={() => router.push({ pathname: `/stories/${story.id}/edit` as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })}><SystemIcon android="edit" color={colors.primary} ios="pencil" size={20} /></Pressable></View><Text style={[styles.meta, { color: colors.textMuted }]}>{nodeNames.get(story.ownerNodeId) || story.ownerNodeId} · {new Date(story.updatedAt).toLocaleString()}</Text>{story.description ? <Text style={[styles.description, { color: colors.textMuted }]}>{story.description}</Text> : null}<Pressable accessibilityRole="button" accessibilityLabel={t('sessions.new')} disabled={Boolean(story.archivedAt) || !newSessionDefaults.instanceId} onPress={() => { if (newSessionDefaults.instanceId) router.push({ pathname: '/sessions/new', params: { instanceId: newSessionDefaults.instanceId, storyId: story.id, ...(newSessionDefaults.cwd ? { cwd: newSessionDefaults.cwd } : {}), ...(newSessionDefaults.cwdFolderId ? { cwdFolderId: newSessionDefaults.cwdFolderId } : {}) } }); }} style={[styles.newSession, { backgroundColor: colors.primary, opacity: story.archivedAt || !newSessionDefaults.instanceId ? 0.5 : 1 }]}><SystemIcon android="add_comment" color="#fff" ios="plus.bubble" size={18} /><Text style={styles.newSessionText}>{t('sessions.new')}</Text></Pressable></View>
    <View onLayout={(event) => setSectionNavHeight(event.nativeEvent.layout.height)} style={[styles.sectionNav, { backgroundColor: colors.background, borderBottomColor: colors.border }]}><ScrollView contentContainerStyle={styles.sectionNavContent} horizontal showsHorizontalScrollIndicator={false}>{storySections.map((section) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: activeSection === section }} key={section} onPress={() => scrollToSection(section)} style={({ pressed }) => [styles.sectionTab, activeSection === section && { borderBottomColor: colors.primary }, pressed && styles.pressed]}><Text style={[styles.sectionTabText, { color: activeSection === section ? colors.primary : colors.textMuted }]}>{t(`stories.${section}Tab` as Parameters<Translate>[0])}</Text></Pressable>)}</ScrollView></View>
    <Section onLayout={(event) => recordSectionOffset('actions', event)} title={t('stories.actions')}>{story.actions.length ? story.actions.map((action) => <View key={action.id} style={[styles.action, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable accessibilityRole="button" accessibilityState={{ busy: runningActionId === action.id, disabled: Boolean(runningActionId) }} disabled={Boolean(runningActionId)} onPress={() => confirmAction(action)} style={styles.actionMain}>{runningActionId === action.id ? <ActivityIndicator color={colors.primary} size="small" /> : <SystemIcon android="play_arrow" color={colors.primary} ios="play.fill" size={18} />}<Text style={[styles.itemTitle, { color: colors.text }]}>{action.title}</Text></Pressable><View style={[styles.countBadge, { backgroundColor: colors.surfaceMuted }]}><SystemIcon android="schedule" color={colors.textMuted} ios="calendar" size={13} /><Text style={[styles.countText, { color: colors.textMuted }]}>{automationCount(action.id)}</Text></View></View>) : <Text style={[styles.muted, { color: colors.textMuted }]}>{t('stories.noActions')}</Text>}</Section>
    <Section onLayout={(event) => recordSectionOffset('documents', event)} title={`${story.documents.length} ${t('stories.documents')}`}>{story.documents.length ? story.documents.map((document) => <Pressable accessibilityRole="button" key={document.storyPath} onPress={() => router.push({ pathname: `/stories/${story.id}/documents/preview` as never, params: { storyId: story.id, nodeId: story.ownerNodeId, storyPath: document.storyPath, title: document.title } })} style={[styles.item, { backgroundColor: colors.surface, borderColor: colors.border }]}><SystemIcon android="description" color={colors.primary} ios="doc.text" size={19} /><View style={styles.itemCopy}><Text style={[styles.itemTitle, { color: colors.text }]}>{document.title}</Text><Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{document.storyPath}</Text></View><SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={17} /></Pressable>) : <Text style={[styles.muted, { color: colors.textMuted }]}>{t('stories.noDocuments')}</Text>}</Section>
    <Section onLayout={(event) => recordSectionOffset('sessions', event)} title={`${linkedSessions.length} ${t('stories.sessions')}`}>{linkedSessions.length ? linkedSessions.map((session) => { const statusGroup = aiSessionStatusGroup(session); const statusLabel = mobileAiSessionStatusLabel(session, t); return <Pressable key={`${session.instanceId}:${session.id}`} accessibilityRole="button" onPress={() => onOpenSession(session.instanceId, session.id)} style={[styles.item, { backgroundColor: colors.surface, borderColor: colors.border }]}>{session.status === 'running' ? <SessionStatusIndicator group={statusGroup} label={statusLabel} size={20} /> : <View style={styles.sessionIcon}><SystemIcon android="chat_bubble_outline" color={colors.textMuted} ios="bubble.left" size={18} /><View style={styles.sessionIconStatus}><SessionStatusIndicator group={statusGroup} label={statusLabel} /></View></View>}<View style={styles.itemCopy}><Text ellipsizeMode="tail" numberOfLines={2} style={[styles.itemTitle, { color: colors.text }]}>{session.title || session.userPrompt || session.summary || session.lastMessage || t('sessions.untitled')}</Text><Text style={[styles.meta, { color: colors.textMuted }]}>{instanceNames.get(session.instanceId) || session.instanceId}</Text></View><SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={17} /></Pressable>; }) : <Text style={[styles.muted, { color: colors.textMuted }]}>{t('stories.noSessions')}</Text>}</Section>
    <Section onLayout={(event) => recordSectionOffset('automations', event)} headerAction={<Pressable accessibilityLabel={t('stories.addAutomation')} disabled={Boolean(story.archivedAt)} onPress={() => router.push({ pathname: `/stories/${story.id}/automations/new` as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })}><SystemIcon android="add_circle" color={colors.primary} ios="plus.circle" size={24} /></Pressable>} title={`${automations.length} ${t('stories.automations')}`}>
      {automationError ? <Text style={[styles.muted, { color: colors.error }]}>{automationError}</Text> : null}
      {!automations.length ? <Text style={[styles.muted, { color: colors.textMuted }]}>{t('stories.noAutomations')}</Text> : automations.map((entry) => {
        const action = story.actions.find((candidate) => candidate.id === entry.automation.actionId);
        const busy = busyAutomationId === entry.automation.id;
        return <View key={entry.automation.id} style={[styles.automation, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.automationHeader}><View style={styles.itemCopy}><Text style={[styles.itemTitle, { color: colors.text }]}>{automationScheduleLabel(entry.automation.schedule, t)}</Text><Text style={[styles.meta, { color: colors.textMuted }]}>{action?.title || entry.automation.actionId}</Text></View><View style={[styles.statusBadge, { backgroundColor: entry.effectiveStatus === 'error' || entry.effectiveStatus === 'blocked' ? colors.errorSoft : colors.primarySoft }]}><Text style={[styles.statusText, { color: entry.effectiveStatus === 'error' || entry.effectiveStatus === 'blocked' ? colors.error : colors.primary }]}>{t(`stories.automation.status.${entry.effectiveStatus}` as Parameters<Translate>[0])}</Text></View></View>
          {entry.nextRunAt ? <Text style={[styles.meta, { color: colors.textMuted }]}>{t('stories.nextRun', { time: new Date(entry.nextRunAt).toLocaleString() })}</Text> : null}
          {entry.blockedReason || entry.lastRun?.error ? <Text style={[styles.meta, { color: colors.error }]}>{(entry.blockedReason || entry.lastRun?.error)?.message}</Text> : null}
          {entry.recentRuns.map((run) => <Pressable disabled={!run.aiSessionId} key={run.id} onPress={() => { if (run.aiSessionId) onOpenSession(run.targetInstanceId, run.aiSessionId); }} style={styles.runRow}><Text style={[styles.meta, { color: run.status === 'failed' ? colors.error : colors.textMuted }]}>{t(`stories.automation.runStatus.${run.status}` as Parameters<Translate>[0])} · {new Date(run.queuedAt).toLocaleString()}</Text>{run.aiSessionId ? <SystemIcon android="open_in_new" color={colors.primary} ios="arrow.up.right.square" size={15} /> : null}</Pressable>)}
          <View style={[styles.automationActions, { borderTopColor: colors.border }]}>
            <IconAction busy={busy} icon={{ android: 'play_circle', ios: 'play.circle' }} label={t('stories.automationRun')} onPress={() => confirmRunAutomation(entry)} />
            <IconAction busy={busy} icon={{ android: entry.automation.enabled ? 'pause_circle' : 'power_settings_new', ios: entry.automation.enabled ? 'pause.circle' : 'power' }} label={t(entry.automation.enabled ? 'stories.automationDisable' : 'stories.automationEnable')} onPress={() => { if (runtime.api) void mutateAutomation(entry.automation.id, () => runtime.api!.stories.setAutomationEnabled(story.id, entry.automation.id, story.ownerNodeId, !entry.automation.enabled)); }} />
            <IconAction busy={busy} icon={{ android: 'edit', ios: 'pencil' }} label={t('stories.editAutomation')} onPress={() => router.push(automationPath(entry.automation.id))} />
            <IconAction busy={busy} destructive icon={{ android: 'delete', ios: 'trash' }} label={t('stories.automationDelete')} onPress={() => confirmDeleteAutomation(entry)} />
          </View>
        </View>;
      })}
    </Section>
  </ScrollView>;
}

function Section({ children, headerAction, onLayout, title }: { children: ReactNode; headerAction?: ReactNode; onLayout?: (event: LayoutChangeEvent) => void; title: string }) {
  const { colors } = useMobileTheme();
  return <View onLayout={onLayout} style={styles.section}><View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>{headerAction}</View>{children}</View>;
}

function IconAction({ busy, destructive, icon, label, onPress }: { busy?: boolean; destructive?: boolean; icon: { android: 'delete' | 'edit' | 'pause_circle' | 'play_circle' | 'power_settings_new'; ios: 'pause.circle' | 'pencil' | 'play.circle' | 'power' | 'trash' }; label: string; onPress(): void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityLabel={label} accessibilityRole="button" disabled={busy} onPress={onPress} style={({ pressed }) => [styles.iconAction, pressed && styles.pressed]}>{busy ? <ActivityIndicator color={colors.primary} size="small" /> : <SystemIcon {...icon} color={destructive ? colors.error : colors.primary} size={21} />}</Pressable>;
}

function automationScheduleLabel(schedule: StoryAutomationSchedule, t: Translate) {
  if (schedule.scheduleKind === 'interval') return t('stories.everyMinutes', { count: schedule.intervalMs / 60_000 });
  if (schedule.scheduleKind === 'daily') return t('stories.dailyAt', { time: schedule.timeOfDay, timezone: schedule.timezone });
  if (schedule.scheduleKind === 'monthly') return t('stories.monthlyAt', { day: schedule.dayOfMonth, time: schedule.timeOfDay, timezone: schedule.timezone });
  const days = schedule.weekdays.map((day) => t(`triggers.form.weekday.${['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][day]}` as Parameters<Translate>[0])).join(', ');
  return t('stories.weeklyAt', { days, time: schedule.timeOfDay, timezone: schedule.timezone });
}

const styles = StyleSheet.create({
  loading: { flex: 1 }, errorState: { flex: 1 }, content: { gap: 22, padding: 16, paddingBottom: 32 }, header: { gap: 7 }, titleRow: { alignItems: 'center', flexDirection: 'row', gap: 12, justifyContent: 'space-between' }, title: { flex: 1, fontSize: 24, fontWeight: '700' }, description: { fontSize: 15, lineHeight: 21 }, meta: { fontSize: 13, lineHeight: 18 },
  newSession: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 5, minHeight: 44, paddingHorizontal: 14 }, newSessionText: { color: '#fff', fontSize: 15, fontWeight: '500' },
  section: { gap: 10 }, sectionHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 28 }, sectionTitle: { fontSize: 18, fontWeight: '600' }, sectionNav: { borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 46 }, sectionNavContent: { gap: 22, paddingHorizontal: 2 }, sectionTab: { borderBottomWidth: 2, borderBottomColor: 'transparent', justifyContent: 'center', minHeight: 46, paddingHorizontal: 2 }, sectionTabText: { fontSize: 14, fontWeight: '600' },
  item: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 11, padding: 14 }, itemCopy: { flex: 1, gap: 4 }, itemTitle: { fontSize: 15, fontWeight: '500' }, sessionIcon: { alignItems: 'center', height: 20, justifyContent: 'center', position: 'relative', width: 20 }, sessionIconStatus: { bottom: -3, position: 'absolute', right: -4, transform: [{ scale: 0.65 }] },
  action: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, paddingRight: 10 }, actionMain: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 10, minHeight: 48, paddingHorizontal: 14 }, countBadge: { alignItems: 'center', borderRadius: 9, flexDirection: 'row', gap: 4, minHeight: 30, paddingHorizontal: 8 }, countText: { fontSize: 12, fontWeight: '600' },
  automation: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 8, overflow: 'hidden', paddingHorizontal: 14, paddingTop: 13 }, automationHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 }, statusBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 }, statusText: { fontSize: 12, fontWeight: '600' }, runRow: { alignItems: 'center', flexDirection: 'row', gap: 6, justifyContent: 'space-between' }, automationActions: { borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'flex-end', marginTop: 3, minHeight: 48 }, iconAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, width: 44 },
  muted: { fontSize: 14 }, pressed: { opacity: 0.62 },
});
