import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Story } from '@task-handoff/protocol/stories';
import { useMobileTheme } from '../components/theme';
import { EmptyState } from '../components/EmptyState';
import { SystemIcon } from '../components/SystemIcon';
import { useI18n } from '../i18n';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useActiveAiSessionsSnapshot } from '../ai-sessions/use-active-sessions';

export function StoryInbox({ onOpen }: { onOpen(story: Story): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const sessions = useActiveAiSessionsSnapshot();
  const [stories, setStories] = useState<Story[]>([]);
  const [unavailableNodeIds, setUnavailableNodeIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const nodeNames = useMemo(() => new Map(directory.nodes.map((node) => [node.id, node.name])), [directory.nodes]);
  const sessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of (sessions?.instances ?? []).flatMap((instance) => instance.aiSessions.sessions)) if (session.storyId) counts.set(session.storyId, (counts.get(session.storyId) ?? 0) + 1);
    return counts;
  }, [sessions]);
  const refresh = useCallback(async () => {
    if (!runtime.api) return;
    setPhase('loading'); setError(undefined);
    try {
      const result = await runtime.api.stories.list();
      setStories(result.stories); setUnavailableNodeIds(result.unavailableNodeIds); setPhase('ready');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setPhase('error'); }
  }, [runtime.api]);
  useEffect(() => { const task = setTimeout(() => { void refresh(); }, 0); return () => clearTimeout(task); }, [refresh]);
  if (phase === 'loading' && stories.length === 0) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  return <FlatList
    data={stories}
    keyExtractor={(item) => `${item.ownerNodeId}:${item.id}`}
    refreshing={phase === 'loading'}
    onRefresh={() => { void refresh(); }}
    contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={[styles.content, { backgroundColor: colors.background }, stories.length === 0 && styles.emptyContent]}
    ListEmptyComponent={<EmptyState icon={phase === 'error' ? { android: 'error_outline', ios: 'exclamationmark.circle' } : { android: 'menu_book', ios: 'book' }} iconColor={phase === 'error' ? colors.error : undefined} message={error || t('stories.empty')} />}
    renderItem={({ item }) => {
      const unavailable = unavailableNodeIds.includes(item.ownerNodeId);
      return <Pressable accessibilityRole="button" onPress={() => onOpen(item)} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.rowCopy}><View style={styles.titleRow}><Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{item.title}</Text>{item.archivedAt ? <Text style={[styles.archived, { backgroundColor: colors.surfaceMuted, color: colors.textMuted }]}>{t('stories.archived')}</Text> : null}</View><Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{nodeNames.get(item.ownerNodeId) || item.ownerNodeId} · {item.documents.length} {t('stories.documents')} · {sessionCounts.get(item.id) ?? 0} {t('stories.sessions')}</Text>{item.description ? <Text numberOfLines={2} style={[styles.description, { color: colors.textMuted }]}>{item.description}</Text> : null}{unavailable ? <Text style={[styles.unavailable, { color: colors.noticeText }]}>{t('stories.nodeUnavailable')}</Text> : null}</View><SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={18} />
      </Pressable>;
    }}
  />;
}

const styles = StyleSheet.create({ loading: { flex: 1 }, content: { gap: 10, padding: 16 }, emptyContent: { flexGrow: 1, justifyContent: 'center' }, row: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, padding: 16 }, rowCopy: { flex: 1, gap: 5 }, titleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 }, title: { flexShrink: 1, fontSize: 16, fontWeight: '600' }, archived: { borderRadius: 6, fontSize: 12, overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 2 }, meta: { fontSize: 13 }, description: { fontSize: 14, lineHeight: 19 }, unavailable: { fontSize: 13 } });
