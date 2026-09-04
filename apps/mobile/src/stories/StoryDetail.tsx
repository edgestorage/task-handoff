import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Crypto from 'expo-crypto';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { Story, StoryAction } from '@task-handoff/protocol/stories';
import { aiSessionStatusGroup } from '@task-handoff/control-plane-client';
import { useMobileTheme } from '../components/theme';
import { EmptyState } from '../components/EmptyState';
import { SystemIcon } from '../components/SystemIcon';
import { useI18n } from '../i18n';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveAiSessionsSnapshot } from '../ai-sessions/use-active-sessions';
import { storyAiSessionCreationDefaults } from '../ai-sessions/new-session-types';
import { SessionStatusIndicator } from '../ai-sessions/SessionStatusIndicator';
import { mobileAiSessionStatusLabel } from '../ai-sessions/SessionDetail';
import { useActiveDirectories } from '../directories/use-directories';
import { createMobileAiSession, lifecycleGuidance } from '../ai-sessions/session-lifecycle';
import { mobilePermissionStore } from '../control-plane/runtime';
import { resolveStoryActionPrompt } from './StoryActionForm';

export function StoryDetail({ storyId, nodeId, onOpenSession }: { storyId?: string; nodeId?: string; onOpenSession(instanceId: string, sessionId: string): void }) {
  const { colors } = useMobileTheme(); const { t } = useI18n(); const runtime = useMobileControlPlaneRuntime(); const { controlPlaneId, state: directory } = useActiveDirectories(); const sessions = useActiveAiSessionsSnapshot();
  const [story, setStory] = useState<Story>(); const [error, setError] = useState<string>(); const [runningActionId, setRunningActionId] = useState<string>();
  useEffect(() => { if (!runtime.api || !storyId || !nodeId) return; let cancelled = false; void runtime.api.stories.get(storyId, nodeId).then((value) => { if (!cancelled) setStory(value); }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }); return () => { cancelled = true; }; }, [nodeId, runtime.api, storyId]);
  const nodeNames = useMemo(() => new Map(directory.nodes.map((node) => [node.id, node.name])), [directory.nodes]);
  const instanceNames = useMemo(() => new Map(directory.instances.map((item) => [item.id, item.name])), [directory.instances]);
  const storyNodeId = story?.ownerNodeId || nodeId || '';
  const storyInstanceIds = useMemo(() => new Set(directory.instances.filter((instance) => instance.nodeId === storyNodeId).map((instance) => instance.id)), [directory.instances, storyNodeId]);
  const linkedSessions = useMemo(() => (sessions?.instances ?? []).flatMap((instance) => instance.aiSessions.sessions.map((session) => ({ ...session, instanceId: instance.instanceId }))).filter((item) => storyInstanceIds.has(item.instanceId) && item.storyId === storyId), [sessions, storyId, storyInstanceIds]);
  const newSessionDefaults = useMemo(() => storyAiSessionCreationDefaults(directory.instances, sessions, storyId || '', storyNodeId), [directory.instances, sessions, storyId, storyNodeId]);
  const runAction = async (action: StoryAction) => {
    if (!runtime.api || !controlPlaneId || !story || runningActionId) return;
    const target = action.targetInstanceId
      ? directory.instances.find((instance) => instance.id === action.targetInstanceId)
      : directory.instances.find((instance) => instance.nodeId === story.ownerNodeId && instance.ready);
    if (!target) { Alert.alert(t('stories.actionFailed'), t('stories.noAvailableInstance')); return; }
    const resolved = resolveStoryActionPrompt(action);
    if (!resolved.ok) { Alert.alert(t('stories.actionFailed'), t('stories.parameterRequired', { name: resolved.missingParameter.label })); return; }
    setRunningActionId(action.id);
    try {
      const preset = action.sessionPreset;
      const agent = preset?.agent ?? 'codex';
      const permissionMode = preset?.permissionMode ?? 'ask';
      const result = await createMobileAiSession(runtime.api, {
        instance: target,
        agent,
        clientRequestId: `story-action-${Crypto.randomUUID()}`,
        message: resolved.message,
        permissionMode,
        mode: preset?.mode,
        cwdFolderId: preset?.cwdFolderId,
        gitSelection: preset?.gitSelection,
        modelSelection: preset?.modelSelection,
        reasoningEffort: preset?.reasoningEffort,
        storyId: story.id,
      });
      if (agent === 'codex') await mobilePermissionStore.write(controlPlaneId, target.id, result.aiSessionId, permissionMode).catch(() => undefined);
      onOpenSession(target.id, result.aiSessionId);
    } catch (cause) {
      Alert.alert(t('stories.actionFailed'), lifecycleGuidance(cause).message);
    } finally {
      setRunningActionId(undefined);
    }
  };
  const confirmAction = (action: StoryAction) => Alert.alert(
    t('stories.executeActionTitle', { name: action.title }),
    t('stories.executeActionDescription'),
    [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('stories.executeAction'), onPress: () => { void runAction(action); } },
    ],
  );
  if (!story && !error) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  if (!story) return <EmptyState icon={{ android: 'error_outline', ios: 'exclamationmark.circle' }} iconColor={colors.error} message={error || t('stories.loadError')} style={styles.errorState} />;
  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.content, { backgroundColor: colors.background }]}>
    <View style={styles.header}><View style={styles.titleRow}><Text style={[styles.title, { color: colors.text }]}>{story.title}</Text><Pressable accessibilityLabel={t('stories.edit')} onPress={() => router.push({ pathname: `/stories/${story.id}/edit` as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })}><SystemIcon android="edit" color={colors.primary} ios="pencil" size={20} /></Pressable></View><Text style={[styles.meta, { color: colors.textMuted }]}>{nodeNames.get(story.ownerNodeId) || story.ownerNodeId} · {new Date(story.updatedAt).toLocaleString()}</Text>{story.description ? <Text style={[styles.description, { color: colors.textMuted }]}>{story.description}</Text> : null}<Pressable accessibilityRole="button" accessibilityLabel={t('sessions.new')} disabled={Boolean(story.archivedAt) || !newSessionDefaults.instanceId} onPress={() => { if (newSessionDefaults.instanceId) router.push({ pathname: '/sessions/new', params: { instanceId: newSessionDefaults.instanceId, storyId: story.id, ...(newSessionDefaults.cwd ? { cwd: newSessionDefaults.cwd } : {}), ...(newSessionDefaults.cwdFolderId ? { cwdFolderId: newSessionDefaults.cwdFolderId } : {}) } }); }} style={[styles.newSession, { backgroundColor: colors.primary, opacity: story.archivedAt || !newSessionDefaults.instanceId ? 0.5 : 1 }]}><SystemIcon android="add_comment" color="#fff" ios="plus.bubble" size={18} /><Text style={styles.newSessionText}>{t('sessions.new')}</Text></Pressable></View>
    <Section title={t('stories.actions')}>{story.actions.length ? story.actions.map((action) => <Pressable key={action.id} accessibilityRole="button" accessibilityState={{ busy: runningActionId === action.id, disabled: Boolean(runningActionId) }} disabled={Boolean(runningActionId)} onPress={() => confirmAction(action)} style={[styles.action, { backgroundColor: colors.surface, borderColor: colors.border, opacity: runningActionId && runningActionId !== action.id ? 0.5 : 1 }]}>{runningActionId === action.id ? <ActivityIndicator color={colors.primary} size="small" /> : <SystemIcon android="play_arrow" color={colors.primary} ios="play.fill" size={18} />}<Text style={[styles.itemTitle, { color: colors.text }]}>{action.title}</Text></Pressable>) : <Text style={[styles.muted, { color: colors.textMuted }]}>{t('stories.noActions')}</Text>}</Section>
    <Section title={`${story.documents.length} ${t('stories.documents')}`}>{story.documents.length ? story.documents.map((document) => <Pressable accessibilityRole="button" key={document.storyPath} onPress={() => router.push({ pathname: `/stories/${story.id}/documents/preview` as never, params: { storyId: story.id, nodeId: story.ownerNodeId, storyPath: document.storyPath, title: document.title } })} style={[styles.item, { backgroundColor: colors.surface, borderColor: colors.border }]}><SystemIcon android="description" color={colors.primary} ios="doc.text" size={19} /><View style={styles.itemCopy}><Text style={[styles.itemTitle, { color: colors.text }]}>{document.title}</Text><Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{document.storyPath}</Text></View><SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={17} /></Pressable>) : <Text style={[styles.muted, { color: colors.textMuted }]}>{t('stories.noDocuments')}</Text>}</Section>
    <Section title={`${linkedSessions.length} ${t('stories.sessions')}`}>{linkedSessions.length ? linkedSessions.map((session) => { const statusGroup = aiSessionStatusGroup(session); const statusLabel = mobileAiSessionStatusLabel(session, t); return <Pressable key={`${session.instanceId}:${session.id}`} accessibilityRole="button" onPress={() => onOpenSession(session.instanceId, session.id)} style={[styles.item, { backgroundColor: colors.surface, borderColor: colors.border }]}>{session.status === 'running' ? <SessionStatusIndicator group={statusGroup} label={statusLabel} size={20} /> : <View style={styles.sessionIcon}><SystemIcon android="chat_bubble_outline" color={colors.textMuted} ios="bubble.left" size={18} /><View style={styles.sessionIconStatus}><SessionStatusIndicator group={statusGroup} label={statusLabel} /></View></View>}<View style={styles.itemCopy}><Text ellipsizeMode="tail" numberOfLines={2} style={[styles.itemTitle, { color: colors.text }]}>{session.title || session.userPrompt || session.summary || session.lastMessage || t('sessions.untitled')}</Text><Text style={[styles.meta, { color: colors.textMuted }]}>{instanceNames.get(session.instanceId) || session.instanceId}</Text></View><SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={17} /></Pressable>; }) : <Text style={[styles.muted, { color: colors.textMuted }]}>{t('stories.noSessions')}</Text>}</Section>
  </ScrollView>;
}
function Section({ title, children }: { title: string; children: ReactNode }) { const { colors } = useMobileTheme(); return <View style={styles.section}><Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>{children}</View>; }
const styles = StyleSheet.create({ loading: { flex: 1 }, errorState: { flex: 1 }, content: { gap: 22, padding: 16, paddingBottom: 32 }, header: { gap: 7 }, titleRow: { alignItems: 'center', flexDirection: 'row', gap: 12, justifyContent: 'space-between' }, title: { flex: 1, fontSize: 24, fontWeight: '700' }, description: { fontSize: 15, lineHeight: 21 }, meta: { fontSize: 13 }, newSession: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 5, minHeight: 44, paddingHorizontal: 14 }, newSessionText: { color: '#fff', fontSize: 15, fontWeight: '500' }, section: { gap: 10 }, sectionTitle: { fontSize: 18, fontWeight: '600' }, item: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 11, padding: 14 }, itemCopy: { flex: 1, gap: 4 }, itemTitle: { fontSize: 15, fontWeight: '500' }, sessionIcon: { alignItems: 'center', height: 20, justifyContent: 'center', position: 'relative', width: 20 }, sessionIconStatus: { bottom: -3, position: 'absolute', right: -4, transform: [{ scale: 0.65 }] }, action: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, padding: 14 }, muted: { fontSize: 14 } });
