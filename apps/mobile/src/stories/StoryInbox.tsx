import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import * as Crypto from 'expo-crypto';
import { aiSessionStatusGroup } from '@task-handoff/control-plane-client';
import type { Story, StoryDocument } from '@task-handoff/protocol/stories';

import { mobileAiSessionStatusLabel } from '../ai-sessions/SessionDetail';
import { SessionStatusIndicator } from '../ai-sessions/SessionStatusIndicator';
import { storyAiSessionCreationDefaults } from '../ai-sessions/new-session-types';
import { useActiveAiSessionsRuntime, useActiveAiSessionsSnapshot } from '../ai-sessions/use-active-sessions';
import { EmptyState } from '../components/EmptyState';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import {
  groupStoryTreeSessions,
  mergeStoryTreeSnapshot,
  sortStoryTree,
  storyTreeKey,
  visibleStoryTreeDocuments,
  STORY_TREE_DOCUMENT_LIMIT,
} from './story-tree-model';
import { getStoryViewPreferences, subscribeStoryViewPreferences, updateStoryViewPreferences } from './story-view-preferences';

type StoryInboxProps = {
  onOpen(story: Story): void;
  onOpenDocument(story: Story, document: StoryDocument): void;
  onOpenSession(instanceId: string, sessionId: string): void;
  onEdit(story: Story): void;
  onNewSession(story: Story, defaults: { instanceId: string; cwd?: string; cwdFolderId?: string }): void;
  onAddExisting?(story: Story): void;
  onAddAction?(story: Story): void;
  onAddAutomation?(story: Story): void;
};

export function StoryInbox({ onAddAction, onAddAutomation, onAddExisting, onEdit, onNewSession, onOpen, onOpenDocument, onOpenSession }: StoryInboxProps) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const sessions = useActiveAiSessionsSnapshot();
  const aiSessionRuntime = useActiveAiSessionsRuntime();
  const preferences = useSyncExternalStore(subscribeStoryViewPreferences, getStoryViewPreferences, getStoryViewPreferences);
  const [stories, setStories] = useState<Story[]>([]);
  const [unavailableNodeIds, setUnavailableNodeIds] = useState<string[]>([]);
  const [expandedStoryKeys, setExpandedStoryKeys] = useState<Set<string>>(() => new Set());
  const [expandedDocumentKeys, setExpandedDocumentKeys] = useState<Set<string>>(() => new Set());
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const [renamingDocument, setRenamingDocument] = useState<{ story: Story; document: StoryDocument; title: string }>();
  const nodeNames = useMemo(() => new Map(directory.nodes.map((node) => [node.id, node.name])), [directory.nodes]);
  const sessionsByStory = useMemo(
    () => groupStoryTreeSessions(stories, directory.instances, sessions),
    [directory.instances, sessions, stories],
  );
  const nodesWithUnassignedSessions = useMemo(() => {
    const instanceNodes = new Map(directory.instances.map((instance) => [instance.id, instance.nodeId]));
    const result = new Set<string>();
    for (const entry of sessions?.instances ?? []) {
      const nodeId = instanceNodes.get(entry.instanceId);
      if (nodeId && entry.aiSessions.sessions.some((session) => !session.storyId)) result.add(nodeId);
    }
    return result;
  }, [directory.instances, sessions]);
  const sortedStories = useMemo(() => sortStoryTree(stories, locale, preferences.sortMode, sessionsByStory, preferences.manualKeys), [locale, preferences.manualKeys, preferences.sortMode, sessionsByStory, stories]);
  useEffect(() => {
    if (preferences.sortMode !== 'manual' || preferences.manualKeys.length || !stories.length) return;
    updateStoryViewPreferences({ manualKeys: sortStoryTree(stories, locale).map(storyTreeKey) });
  }, [locale, preferences.manualKeys.length, preferences.sortMode, stories]);
  const refresh = useCallback(async () => {
    if (!runtime.api) return;
    setPhase('loading');
    setError(undefined);
    try {
      const result = await runtime.api.stories.list();
      setStories((current) => mergeStoryTreeSnapshot(current, result.stories, result.unavailableNodeIds));
      setUnavailableNodeIds(result.unavailableNodeIds);
      setPhase('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('error');
    }
  }, [runtime.api]);
  const replaceStory = useCallback((updated: Story) => setStories((current) => current.map((story) => storyTreeKey(story) === storyTreeKey(updated) ? updated : story)), []);
  const toggleArchive = useCallback(async (story: Story) => {
    if (!runtime.api) return;
    try { replaceStory(story.archivedAt ? await runtime.api.stories.restore(story.id, story.ownerNodeId) : await runtime.api.stories.archive(story.id, story.ownerNodeId)); }
    catch (cause) { Alert.alert(t('stories.saveError'), cause instanceof Error ? cause.message : String(cause)); }
  }, [replaceStory, runtime.api, t]);
  const removeStory = useCallback((story: Story) => Alert.alert(t('stories.deleteTitle', { name: story.title }), t('stories.deleteDescription'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('common.remove'), style: 'destructive', onPress: () => { void runtime.api?.stories.remove(story.id, story.ownerNodeId).then(() => setStories((current) => current.filter((candidate) => storyTreeKey(candidate) !== storyTreeKey(story)))).catch((cause) => Alert.alert(t('stories.saveError'), cause instanceof Error ? cause.message : String(cause))); } },
  ]), [runtime.api, t]);
  const removeDocument = useCallback((story: Story, document: StoryDocument) => Alert.alert(t('stories.deleteDocumentTitle', { name: document.title }), t('stories.deleteDocumentDescription'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('common.remove'), style: 'destructive', onPress: () => { void runtime.api?.stories.removeDocument(story.id, story.ownerNodeId, document.storyPath).then(refresh).catch((cause) => Alert.alert(t('stories.saveError'), cause instanceof Error ? cause.message : String(cause))); } },
  ]), [refresh, runtime.api, t]);
  const saveDocumentTitle = useCallback(async () => {
    const target = renamingDocument;
    if (!runtime.api || !target?.title.trim()) return;
    try {
      replaceStory(await runtime.api.stories.updateDocument(target.story.id, target.story.ownerNodeId, target.document.storyPath, { title: target.title.trim() }));
      setRenamingDocument(undefined);
    } catch (cause) { Alert.alert(t('stories.saveError'), cause instanceof Error ? cause.message : String(cause)); }
  }, [renamingDocument, replaceStory, runtime.api, t]);
  const closeSession = useCallback((entry: { instanceId: string; session: { id: string; title?: string; userPrompt?: string } }) => Alert.alert(
    t('sessions.closeConfirmTitle', { name: entry.session.title || entry.session.userPrompt || entry.session.id }),
    t('sessions.closeConfirmDescription'),
    [{ text: t('common.cancel'), style: 'cancel' }, { text: t('sessions.closeSession'), style: 'destructive', onPress: () => { void aiSessionRuntime.actions?.close(entry.instanceId, entry.session.id, Crypto.randomUUID()).catch((cause) => Alert.alert(t('sessions.closeFailed'), cause instanceof Error ? cause.message : String(cause))); } }],
  ), [aiSessionRuntime.actions, t]);

  useEffect(() => {
    const task = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(task);
  }, [refresh]);

  if (phase === 'loading' && stories.length === 0) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  const emptyUnavailable = sortedStories.length === 0 && unavailableNodeIds.length > 0;
  const emptyError = phase === 'error' || emptyUnavailable;
  return <><FlatList
    contentContainerStyle={[styles.content, { backgroundColor: colors.background }, sortedStories.length === 0 && styles.emptyContent]}
    contentInsetAdjustmentBehavior="automatic"
    data={sortedStories}
    keyExtractor={storyTreeKey}
    ListEmptyComponent={<EmptyState
      icon={emptyError ? { android: 'error_outline', ios: 'exclamationmark.circle' } : { android: 'menu_book', ios: 'book' }}
      iconColor={emptyError ? colors.error : undefined}
      message={error || (emptyUnavailable ? t('stories.loadError') : t('stories.empty'))}
      style={styles.emptyState}
    />}
    onRefresh={() => { void refresh(); }}
    refreshing={phase === 'loading'}
    testID="story-list"
    renderItem={({ item: story }) => {
        const key = storyTreeKey(story);
        const expanded = expandedStoryKeys.has(key);
        const unavailable = unavailableNodeIds.includes(story.ownerNodeId);
        const storySessions = sessionsByStory.get(key) ?? [];
        const documents = visibleStoryTreeDocuments(story.documents, expandedDocumentKeys.has(key));
        const newSessionDefaults = storyAiSessionCreationDefaults(directory.instances, sessions, story.id, story.ownerNodeId);
        return <View style={[styles.storyGroup, { borderColor: colors.border }]}>
        <View style={[styles.storyRow, expanded && styles.storyRowExpanded, expanded && { borderBottomColor: colors.border }]}>
          <Pressable
            accessibilityLabel={t(expanded ? 'stories.collapse' : 'stories.expand', { name: story.title })}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            hitSlop={8}
            onPress={() => setExpandedStoryKeys((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key); else next.add(key);
              return next;
            })}
            style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}
          >
            <SystemIcon android={expanded ? 'expand_more' : 'chevron_right'} color={colors.textMuted} ios={expanded ? 'chevron.down' : 'chevron.right'} size={17} />
          </Pressable>
          <MenuView
            actions={[
              { id: 'new-session', image: 'plus.bubble', title: t('sessions.new'), attributes: { disabled: Boolean(story.archivedAt) || !newSessionDefaults.instanceId } },
              { id: 'add-existing', image: 'link', title: t('stories.addExistingSession'), attributes: { disabled: Boolean(story.archivedAt) || !nodesWithUnassignedSessions.has(story.ownerNodeId) } },
              { id: 'add-action', image: 'play.fill', title: t('stories.createAction'), attributes: { disabled: Boolean(story.archivedAt) } },
              { id: 'add-automation', image: 'calendar.badge.clock', title: t('stories.addAutomation'), attributes: { disabled: Boolean(story.archivedAt) } },
              { id: 'edit', image: 'pencil', title: t('stories.edit') },
              { id: 'archive', image: story.archivedAt ? 'arrow.uturn.backward' : 'archivebox', title: t(story.archivedAt ? 'stories.restore' : 'stories.archive') },
              { id: 'delete', image: 'trash', title: t('common.remove'), attributes: { destructive: true } },
            ] as MenuAction[]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === 'new-session' && newSessionDefaults.instanceId) {
                onNewSession(story, { ...newSessionDefaults, instanceId: newSessionDefaults.instanceId });
              }
              else if (nativeEvent.event === 'add-existing') onAddExisting?.(story);
              else if (nativeEvent.event === 'add-action') onAddAction?.(story);
              else if (nativeEvent.event === 'add-automation') onAddAutomation?.(story);
              else if (nativeEvent.event === 'edit') onEdit(story);
              else if (nativeEvent.event === 'archive') void toggleArchive(story);
              else if (nativeEvent.event === 'delete') removeStory(story);
            }}
            shouldOpenOnLongPress
            style={styles.storyMenu}
            title={story.title}
          >
          <Pressable accessibilityRole="button" onPress={() => onOpen(story)} style={({ pressed }) => [styles.storyLink, pressed && { backgroundColor: colors.surfaceMuted }]}>
            <View style={styles.nodeIcon}><SystemIcon android="menu_book" color={colors.primary} ios="book" size={18} /></View>
            <View style={styles.rowCopy}>
              <View style={styles.titleRow}>
                <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{story.title}</Text>
                {story.archivedAt ? <Text style={[styles.archived, { backgroundColor: colors.surfaceMuted, color: colors.textMuted }]}>{t('stories.archived')}</Text> : null}
              </View>
              {preferences.viewMode === 'detailed' ? <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{nodeNames.get(story.ownerNodeId) || story.ownerNodeId}</Text> : null}
              {unavailable ? <Text style={[styles.unavailable, { color: colors.noticeText }]}>{t('stories.nodeUnavailable')}</Text> : null}
            </View>
          </Pressable>
          </MenuView>
        </View>
        {expanded ? <View style={styles.children}>
          {documents.map((document) => <MenuView actions={[
            { id: 'open', image: 'doc.text', title: t('common.open') },
            { id: 'rename', image: 'pencil', title: t('common.rename'), attributes: { disabled: Boolean(story.archivedAt) } },
            { id: 'delete', image: 'trash', title: t('common.remove'), attributes: { destructive: true, disabled: Boolean(story.archivedAt) } },
          ] as MenuAction[]} key={document.storyPath} onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === 'open') onOpenDocument(story, document);
            else if (nativeEvent.event === 'rename') setRenamingDocument({ story, document, title: document.title });
            else if (nativeEvent.event === 'delete') removeDocument(story, document);
          }} shouldOpenOnLongPress style={styles.childMenu} title={document.title}>
          <Pressable accessibilityRole="button" onPress={() => onOpenDocument(story, document)} style={({ pressed }) => [styles.childRow, pressed && { backgroundColor: colors.surfaceMuted }]}>
            <View style={styles.nodeIcon}><SystemIcon android="description" color={colors.textMuted} ios="doc.text" size={18} /></View>
            <View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.childTitle, { color: colors.text }]}>{document.title}</Text>{preferences.viewMode === 'detailed' ? <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{document.storyPath}</Text> : null}</View>
          </Pressable></MenuView>)}
          {story.documents.length > STORY_TREE_DOCUMENT_LIMIT && !expandedDocumentKeys.has(key) ? <Pressable accessibilityRole="button" onPress={() => setExpandedDocumentKeys((current) => new Set(current).add(key))} style={({ pressed }) => [styles.moreRow, pressed && styles.pressed]}><Text style={[styles.moreText, { color: colors.primary }]}>{t('stories.moreDocuments')}</Text></Pressable> : null}
          {storySessions.map((entry) => {
            const statusGroup = aiSessionStatusGroup(entry.session);
            return <MenuView actions={[
              { id: 'open', image: 'bubble.left', title: t('common.open') },
              { id: 'close', image: 'xmark.circle', title: t('sessions.closeSession'), attributes: { destructive: true, disabled: !aiSessionRuntime.actions } },
            ] as MenuAction[]} key={`${entry.instanceId}:${entry.session.id}`} onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === 'open') onOpenSession(entry.instanceId, entry.session.id);
              else if (nativeEvent.event === 'close') closeSession(entry);
            }} shouldOpenOnLongPress style={styles.childMenu} title={entry.session.title || entry.session.userPrompt || entry.session.id}>
            <Pressable accessibilityRole="button" onPress={() => onOpenSession(entry.instanceId, entry.session.id)} style={({ pressed }) => [styles.childRow, pressed && { backgroundColor: colors.surfaceMuted }]}>
              {entry.session.status === 'running'
                ? <View style={styles.nodeIcon}><SessionStatusIndicator group={statusGroup} label={mobileAiSessionStatusLabel(entry.session, t)} size={18} /></View>
                : <View style={styles.sessionIcon}><SystemIcon android="chat_bubble_outline" color={colors.textMuted} ios="bubble.left" size={18} />{entry.session.status !== 'idle' ? <View style={styles.sessionIconStatus}><SessionStatusIndicator group={statusGroup} label={mobileAiSessionStatusLabel(entry.session, t)} size={16} /></View> : null}</View>}
              <View style={styles.rowCopy}><View style={styles.sessionTitleRow}><Text numberOfLines={1} style={[styles.childTitle, { color: colors.text }]}>{entry.session.title || entry.session.userPrompt || entry.session.id}</Text>{entry.session.unread ? <View accessibilityLabel={t('sessions.unread')} style={[styles.unread, { backgroundColor: colors.primary }]} /> : null}</View>{preferences.viewMode === 'detailed' ? <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{entry.instanceName} · {mobileAiSessionStatusLabel(entry.session, t)}</Text> : null}</View>
            </Pressable></MenuView>;
          })}
          {!storySessions.length ? <Text style={[styles.emptyChild, { color: colors.textMuted }]}>{t('stories.noSessions')}</Text> : null}
        </View> : null}
      </View>;
    }}
  />
  <Modal animationType="fade" onRequestClose={() => setRenamingDocument(undefined)} transparent visible={Boolean(renamingDocument)}>
    <View style={styles.modalBackdrop}><View style={[styles.renameDialog, { backgroundColor: colors.surface }]}>
      <Text style={[styles.renameTitle, { color: colors.text }]}>{t('common.rename')}</Text>
      <TextInput autoFocus maxLength={240} onChangeText={(title) => setRenamingDocument((current) => current ? { ...current, title } : current)} selectTextOnFocus style={[styles.renameInput, { borderColor: colors.border, color: colors.text }]} value={renamingDocument?.title || ''} />
      <View style={styles.renameActions}><Pressable accessibilityRole="button" onPress={() => setRenamingDocument(undefined)} style={styles.renameAction}><Text style={[styles.renameActionText, { color: colors.textMuted }]}>{t('common.cancel')}</Text></Pressable><Pressable accessibilityRole="button" disabled={!renamingDocument?.title.trim()} onPress={() => { void saveDocumentTitle(); }} style={styles.renameAction}><Text style={[styles.renameActionText, { color: colors.primary, opacity: renamingDocument?.title.trim() ? 1 : 0.4 }]}>{t('common.save')}</Text></Pressable></View>
    </View></View>
  </Modal>
  </>;
}

const styles = StyleSheet.create({
  loading: { flex: 1 },
  content: { paddingBottom: 24, paddingHorizontal: 12, paddingTop: 8 },
  emptyContent: { paddingTop: 32 },
  emptyState: { minHeight: 180 },
  storyGroup: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 10, overflow: 'hidden' },
  storyRow: { alignItems: 'center', flexDirection: 'row', minHeight: 51 },
  storyRowExpanded: { borderBottomWidth: StyleSheet.hairlineWidth },
  storyMenu: { alignSelf: 'stretch', flex: 1, justifyContent: 'center' },
  disclosure: { alignItems: 'center', alignSelf: 'stretch', justifyContent: 'center', width: 32 },
  storyLink: { alignItems: 'center', borderRadius: 7, flex: 1, flexDirection: 'row', gap: 10, minHeight: 49, paddingRight: 5, paddingVertical: 5 },
  children: { marginBottom: 6, marginLeft: 16, marginTop: 4, paddingLeft: 16, paddingRight: 8 },
  childRow: { alignItems: 'center', borderRadius: 7, flexDirection: 'row', gap: 10, minHeight: 44, paddingHorizontal: 0, paddingVertical: 5 },
  childMenu: { alignSelf: 'stretch' },
  moreRow: { borderRadius: 7, justifyContent: 'center', minHeight: 40 },
  emptyChild: { fontSize: 14, lineHeight: 40, minHeight: 40 },
  nodeIcon: { alignItems: 'center', height: 20, justifyContent: 'center', width: 22 },
  rowCopy: { flex: 1, gap: 1, justifyContent: 'center', minWidth: 0 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  sessionTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  title: { flexShrink: 1, fontSize: 17, fontWeight: '500', lineHeight: 24 },
  childTitle: { flexShrink: 1, fontSize: 16, fontWeight: '400', lineHeight: 22 },
  archived: { borderRadius: 5, fontSize: 14, overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 2 },
  meta: { fontSize: 14, lineHeight: 18 },
  unavailable: { fontSize: 14, lineHeight: 18 },
  moreText: { fontSize: 15, lineHeight: 20 },
  unread: { borderRadius: 4, height: 8, width: 8 },
  sessionIcon: { alignItems: 'center', height: 20, justifyContent: 'center', position: 'relative', width: 22 },
  sessionIconStatus: { bottom: -4, position: 'absolute', right: -3, transform: [{ scale: 0.62 }] },
  pressed: { opacity: 0.62 },
  modalBackdrop: { alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.36)', flex: 1, justifyContent: 'center', padding: 24 },
  renameDialog: { borderRadius: 12, gap: 16, maxWidth: 420, padding: 18, width: '100%' },
  renameTitle: { fontSize: 17, fontWeight: '600' },
  renameInput: { borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, minHeight: 44, paddingHorizontal: 12 },
  renameActions: { flexDirection: 'row', justifyContent: 'flex-end' },
  renameAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 72, paddingHorizontal: 10 },
  renameActionText: { fontSize: 15, fontWeight: '500' },
});
