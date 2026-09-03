import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { aiSessionStatusGroup } from '@task-handoff/control-plane-client';
import type { Story, StoryDocument } from '@task-handoff/protocol/stories';

import { mobileAiSessionStatusLabel } from '../ai-sessions/SessionDetail';
import { SessionStatusIndicator } from '../ai-sessions/SessionStatusIndicator';
import { useActiveAiSessionsSnapshot } from '../ai-sessions/use-active-sessions';
import { EmptyState } from '../components/EmptyState';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import {
  groupStoryTreeSessions,
  sortStoryTree,
  storyTreeKey,
  visibleStoryTreeDocuments,
  STORY_TREE_DOCUMENT_LIMIT,
  type StoryTreeSession,
} from './story-tree-model';

type StoryInboxProps = {
  onOpen(story: Story): void;
  onOpenDocument(story: Story, document: StoryDocument): void;
  onOpenSession(instanceId: string, sessionId: string): void;
};

type TreeRow =
  | { key: string; kind: 'story'; story: Story; sessions: StoryTreeSession[] }
  | { key: string; kind: 'document'; story: Story; document: StoryDocument }
  | { key: string; kind: 'more-documents'; story: Story }
  | { key: string; kind: 'session'; entry: StoryTreeSession }
  | { key: string; kind: 'empty-sessions' };

export function StoryInbox({ onOpen, onOpenDocument, onOpenSession }: StoryInboxProps) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const sessions = useActiveAiSessionsSnapshot();
  const [stories, setStories] = useState<Story[]>([]);
  const [unavailableNodeIds, setUnavailableNodeIds] = useState<string[]>([]);
  const [expandedStoryKeys, setExpandedStoryKeys] = useState<Set<string>>(() => new Set());
  const [expandedDocumentKeys, setExpandedDocumentKeys] = useState<Set<string>>(() => new Set());
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const nodeNames = useMemo(() => new Map(directory.nodes.map((node) => [node.id, node.name])), [directory.nodes]);
  const sortedStories = useMemo(() => sortStoryTree(stories, locale), [locale, stories]);
  const sessionsByStory = useMemo(
    () => groupStoryTreeSessions(stories, directory.instances, sessions),
    [directory.instances, sessions, stories],
  );
  const rows = useMemo(() => sortedStories.flatMap<TreeRow>((story) => {
    const key = storyTreeKey(story);
    const storySessions = sessionsByStory.get(key) ?? [];
    const result: TreeRow[] = [{ key: `story:${key}`, kind: 'story', story, sessions: storySessions }];
    if (!expandedStoryKeys.has(key)) return result;
    for (const document of visibleStoryTreeDocuments(story.documents, expandedDocumentKeys.has(key))) {
      result.push({ key: `document:${key}:${document.storyPath}`, kind: 'document', story, document });
    }
    if (story.documents.length > STORY_TREE_DOCUMENT_LIMIT && !expandedDocumentKeys.has(key)) {
      result.push({ key: `more-documents:${key}`, kind: 'more-documents', story });
    }
    for (const entry of storySessions) result.push({ key: `session:${key}:${entry.instanceId}:${entry.session.id}`, kind: 'session', entry });
    if (!storySessions.length) result.push({ key: `empty-sessions:${key}`, kind: 'empty-sessions' });
    return result;
  }), [expandedDocumentKeys, expandedStoryKeys, sessionsByStory, sortedStories]);

  const refresh = useCallback(async () => {
    if (!runtime.api) return;
    setPhase('loading');
    setError(undefined);
    try {
      const result = await runtime.api.stories.list();
      setStories(result.stories);
      setUnavailableNodeIds(result.unavailableNodeIds);
      setPhase('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('error');
    }
  }, [runtime.api]);

  useEffect(() => {
    const task = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(task);
  }, [refresh]);

  if (phase === 'loading' && stories.length === 0) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  return <FlatList
    contentContainerStyle={[styles.content, { backgroundColor: colors.background }, rows.length === 0 && styles.emptyContent]}
    contentInsetAdjustmentBehavior="automatic"
    data={rows}
    keyExtractor={(item) => item.key}
    ListEmptyComponent={<EmptyState icon={phase === 'error' ? { android: 'error_outline', ios: 'exclamationmark.circle' } : { android: 'menu_book', ios: 'book' }} iconColor={phase === 'error' ? colors.error : undefined} message={error || t('stories.empty')} />}
    onRefresh={() => { void refresh(); }}
    refreshing={phase === 'loading'}
    renderItem={({ item }) => {
      if (item.kind === 'story') {
        const key = storyTreeKey(item.story);
        const expanded = expandedStoryKeys.has(key);
        const unavailable = unavailableNodeIds.includes(item.story.ownerNodeId);
        return <View style={[styles.storyRow, { borderBottomColor: colors.border }]}>
          <Pressable
            accessibilityLabel={t(expanded ? 'stories.collapse' : 'stories.expand', { name: item.story.title })}
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
            <SystemIcon android={expanded ? 'expand_more' : 'chevron_right'} color={colors.textMuted} ios={expanded ? 'chevron.down' : 'chevron.right'} size={15} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => onOpen(item.story)} style={({ pressed }) => [styles.storyLink, pressed && styles.pressed]}>
            <SystemIcon android="menu_book" color={colors.primary} ios="book" size={19} />
            <View style={styles.rowCopy}>
              <View style={styles.titleRow}>
                <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{item.story.title}</Text>
                {item.story.archivedAt ? <Text style={[styles.archived, { backgroundColor: colors.surfaceMuted, color: colors.textMuted }]}>{t('stories.archived')}</Text> : null}
              </View>
              <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{nodeNames.get(item.story.ownerNodeId) || item.story.ownerNodeId} · {item.story.documents.length} {t('stories.documents')} · {item.sessions.length} {t('stories.sessions')}</Text>
              {unavailable ? <Text style={[styles.unavailable, { color: colors.noticeText }]}>{t('stories.nodeUnavailable')}</Text> : null}
            </View>
            <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={15} />
          </Pressable>
        </View>;
      }
      if (item.kind === 'document') return <Pressable accessibilityRole="button" onPress={() => onOpenDocument(item.story, item.document)} style={({ pressed }) => [styles.childRow, { borderBottomColor: colors.border }, pressed && styles.pressed]}>
        <View style={[styles.branch, { borderLeftColor: colors.border }]} />
        <SystemIcon android="description" color={colors.textMuted} ios="doc.text" size={17} />
        <View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.childTitle, { color: colors.text }]}>{item.document.title}</Text><Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{item.document.storyPath}</Text></View>
        <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={14} />
      </Pressable>;
      if (item.kind === 'more-documents') return <Pressable accessibilityRole="button" onPress={() => setExpandedDocumentKeys((current) => new Set(current).add(storyTreeKey(item.story)))} style={({ pressed }) => [styles.moreRow, { borderBottomColor: colors.border }, pressed && styles.pressed]}>
        <View style={[styles.branch, { borderLeftColor: colors.border }]} /><Text style={[styles.moreText, { color: colors.primary }]}>{t('stories.moreDocuments')}</Text>
      </Pressable>;
      if (item.kind === 'empty-sessions') return <View style={[styles.emptyChildRow, { borderBottomColor: colors.border }]}><View style={[styles.branch, { borderLeftColor: colors.border }]} /><Text style={[styles.meta, { color: colors.textMuted }]}>{t('stories.noSessions')}</Text></View>;
      const statusGroup = aiSessionStatusGroup(item.entry.session);
      return <Pressable accessibilityRole="button" onPress={() => onOpenSession(item.entry.instanceId, item.entry.session.id)} style={({ pressed }) => [styles.childRow, { borderBottomColor: colors.border }, pressed && styles.pressed]}>
        <View style={[styles.branch, { borderLeftColor: colors.border }]} />
        <SessionStatusIndicator group={statusGroup} label={mobileAiSessionStatusLabel(item.entry.session, t)} />
        <View style={styles.rowCopy}><View style={styles.sessionTitleRow}><Text numberOfLines={1} style={[styles.childTitle, { color: colors.text }]}>{item.entry.session.title || item.entry.session.userPrompt || item.entry.session.id}</Text>{item.entry.session.unread ? <View accessibilityLabel={t('sessions.unread')} style={[styles.unread, { backgroundColor: colors.primary }]} /> : null}</View><Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{item.entry.instanceName}</Text></View>
        <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={14} />
      </Pressable>;
    }}
  />;
}

const styles = StyleSheet.create({
  loading: { flex: 1 },
  content: { paddingHorizontal: 16, paddingVertical: 8 },
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
  storyRow: { alignItems: 'stretch', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 68 },
  disclosure: { alignItems: 'center', justifyContent: 'center', width: 28 },
  storyLink: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 10, paddingVertical: 11 },
  childRow: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 58, paddingLeft: 28, paddingRight: 4, paddingVertical: 8 },
  emptyChildRow: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 44, paddingLeft: 28 },
  moreRow: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 44, paddingLeft: 28 },
  branch: { alignSelf: 'stretch', borderLeftWidth: StyleSheet.hairlineWidth, marginRight: 8, width: 1 },
  rowCopy: { flex: 1, gap: 3, minWidth: 0 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  sessionTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  title: { flexShrink: 1, fontSize: 16, fontWeight: '500' },
  childTitle: { flexShrink: 1, fontSize: 14, fontWeight: '500' },
  archived: { borderRadius: 5, fontSize: 12, overflow: 'hidden', paddingHorizontal: 5, paddingVertical: 1 },
  meta: { fontSize: 12, lineHeight: 17 },
  unavailable: { fontSize: 12 },
  moreText: { fontSize: 13 },
  unread: { borderRadius: 4, height: 7, width: 7 },
  pressed: { opacity: 0.62 },
});
