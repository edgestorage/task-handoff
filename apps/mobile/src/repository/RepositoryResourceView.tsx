import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ControlPlaneClient, RepositorySessionTarget } from '@task-handoff/control-plane-client';
import type { RepositoryChanges, RepositoryDiff, RepositoryDirectoryListing, RepositoryFileContent, RepositoryWorktrees } from '@task-handoff/protocol/repository';

import { useResourceBack } from '../components/resource-back';
import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { repositoryViewMemory, updateRepositoryViewNavigation } from './view-memory';
import type { RepositoryResourcePage } from '../ai-sessions/resource-workspace-model';

type RepositoryRead =
  | { kind: 'directory'; data: RepositoryDirectoryListing }
  | { kind: 'file'; data: RepositoryFileContent }
  | { kind: 'changes'; data: RepositoryChanges }
  | { kind: 'diff'; data: RepositoryDiff }
  | { kind: 'worktrees'; data: RepositoryWorktrees };

/** Explicit, abortable reads. The repository protocol currently has no change-event stream. */
export function RepositoryResourceView({ active, client, cwdFolderId, page, ready, target, workspaceIdentity }: {
  active: boolean;
  client?: ControlPlaneClient;
  cwdFolderId?: string;
  page: RepositoryResourcePage;
  ready: boolean;
  target: RepositorySessionTarget;
  workspaceIdentity: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const memoryKey = JSON.stringify([workspaceIdentity, page]);
  const memory = useMemo(() => repositoryViewMemory(memoryKey), [memoryKey]);
  const [navigationState, setNavigationState] = useState({ memory, value: memory.navigation });
  const navigation = navigationState.memory === memory ? navigationState.value : memory.navigation;
  const { directories, filePath, change } = navigation;
  const navigate = useCallback((update: (current: typeof navigation) => typeof navigation) => {
    const next = updateRepositoryViewNavigation(memoryKey, update);
    setNavigationState({ memory, value: next });
  }, [memory, memoryKey]);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value?: RepositoryRead; error?: string }>();
  const scrollTo = useRef<((options: { offset: number; animated: boolean }) => void) | undefined>(undefined);
  const offsets = memory.offsets;
  const path = directories.at(-1) || '';
  const key = JSON.stringify([workspaceIdentity, page, path, filePath, change?.path, change?.scope, refresh]);
  const request = useRef(0);
  useEffect(() => {
    if (!active || !ready || !client) return;
    const abort = new AbortController();
    const generation = ++request.current;
    const read = async (): Promise<RepositoryRead> => {
      if (page === 'files') {
        return filePath ? { kind: 'file', data: await client.repository.file(target, filePath, { signal: abort.signal }) }
          : { kind: 'directory', data: await client.repository.directory(target, path, { signal: abort.signal }) };
      }
      if (page === 'changes') {
        return change ? { kind: 'diff', data: await client.repository.diff(target, { path: change.path, scope: change.scope, byteLimit: 128 * 1024 }, { signal: abort.signal }) }
          : { kind: 'changes', data: await client.repository.changes(target, { signal: abort.signal }) };
      }
      return { kind: 'worktrees', data: await client.repository.worktrees({ instanceId: target.instanceId, cwdFolderId, legacySession: target }, { signal: abort.signal }) };
    };
    void read().then((value) => {
      if (!abort.signal.aborted && request.current === generation) setResult({ key, value });
    }).catch((error: unknown) => {
      if (!abort.signal.aborted && request.current === generation) setResult({ key, error: error instanceof Error ? error.message : t('sessionResources.loadFailed') });
    });
    return () => abort.abort();
  // Keys encode the complete request target. A new workspace is mounted with a new identity by the owner.
  }, [active, change, client, cwdFolderId, filePath, key, page, path, ready, target, t]);
  const goBack = useCallback(() => {
    if (filePath) { navigate((current) => ({ ...current, filePath: undefined })); return true; }
    if (change) { navigate((current) => ({ ...current, change: undefined })); return true; }
    if (page === 'files' && directories.length > 1) { navigate((current) => ({ ...current, directories: current.directories.slice(0, -1) })); return true; }
    return false;
  }, [change, directories.length, filePath, navigate, page]);
  useResourceBack(active && Boolean(filePath || change || directories.length > 1), goBack);
  const value = result?.key === key ? result.value : undefined;
  const error = result?.key === key ? result.error : undefined;
  const navigationKey = `${page}:${filePath || change?.path || path}`;
  const label = filePath || change?.path || path || t(`sessionResources.${page}`);
  const backAvailable = Boolean(filePath || change || directories.length > 1);
  const restorePosition = () => {
    const offset = offsets.get(navigationKey);
    if (offset) scrollTo.current?.({ offset, animated: false });
  };
  const row = (title: string, subtitle: string | undefined, icon: 'folder-outline' | 'document-text-outline' | 'git-branch-outline', onPress?: () => void, selected = false) => <Pressable
    accessibilityRole={onPress ? 'button' : undefined} accessibilityState={{ selected }} disabled={!onPress}
    onPress={onPress} style={({ pressed }) => [styles.row, { borderBottomColor: colors.border }, pressed && styles.pressed]}
  >
    <Icon color={selected ? colors.primary : colors.textMuted} name={icon} size={20} />
    <View style={styles.rowCopy}><Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>{subtitle ? <Text style={[styles.rowSubtitle, { color: colors.textMuted }]}>{subtitle}</Text> : null}</View>
    {selected ? <Icon color={colors.primary} name="checkmark" /> : onPress ? <Icon color={colors.textMuted} name="chevron-forward" size={16} /> : null}
  </Pressable>;
  return <View style={styles.root}>
    <View style={[styles.toolbar, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
      {backAvailable ? <Pressable accessibilityLabel={t('sessionResources.back')} accessibilityRole="button" onPress={goBack} style={styles.button}><Icon name="chevron-back" color={colors.primary} /></Pressable> : null}
      <Text accessibilityLabel={label} numberOfLines={1} style={[styles.path, { color: colors.text }]}>{label}</Text>
      <Pressable accessibilityLabel={t('sessionResources.refresh')} accessibilityRole="button" disabled={!ready} onPress={() => setRefresh((current) => current + 1)} style={styles.button}><Icon name="refresh" color={ready ? colors.primary : colors.textMuted} /></Pressable>
    </View>
    <Text style={[styles.notice, { color: colors.textMuted }]}>{t('sessionResources.snapshot')}</Text>
    {!ready ? <Text style={[styles.message, { color: colors.textMuted }]}>{t('sessionResources.unavailable')}</Text>
      : error ? <View style={styles.message}><Text selectable style={{ color: colors.error, fontSize: 14 }}>{error}</Text><Pressable accessibilityRole="button" onPress={() => setRefresh((current) => current + 1)} style={styles.retry}><Text style={{ color: colors.primary, fontSize: 14 }}>{t('common.retry')}</Text></Pressable></View>
        : !value ? <ActivityIndicator style={styles.loading} />
          : value.kind === 'directory' ? <FlatList
            key={navigationKey} ref={(list) => { scrollTo.current = list ? (options) => list.scrollToOffset(options) : undefined; }} data={value.data.entries} keyExtractor={(item) => item.path}
            onScroll={(event) => offsets.set(navigationKey, event.nativeEvent.contentOffset.y)} onContentSizeChange={restorePosition}
            ListEmptyComponent={<Text style={[styles.message, { color: colors.textMuted }]}>{t('sessionResources.emptyDirectory')}</Text>}
            renderItem={({ item }) => row(item.name, item.kind === 'directory' ? undefined : item.kind, item.traversable ? 'folder-outline' : 'document-text-outline', item.traversable
              ? () => navigate((current) => ({ ...current, directories: [...current.directories, item.path] }))
              : item.kind === 'file' ? () => navigate((current) => ({ ...current, filePath: item.path })) : undefined)}
          />
            : value.kind === 'changes' ? <FlatList
              key={navigationKey} ref={(list) => { scrollTo.current = list ? (options) => list.scrollToOffset(options) : undefined; }} data={value.data.entries} keyExtractor={(item) => `${item.scope}:${item.path}`}
              onScroll={(event) => offsets.set(navigationKey, event.nativeEvent.contentOffset.y)} onContentSizeChange={restorePosition}
              ListEmptyComponent={<Text style={[styles.message, { color: colors.textMuted }]}>{t('sessionResources.noChanges')}</Text>}
              renderItem={({ item }) => row(item.path, t(`sessionResources.scope.${item.scope}`), 'document-text-outline', () => navigate((current) => ({ ...current, change: { path: item.path, scope: item.scope } })))}
            />
              : value.kind === 'worktrees' ? <FlatList data={value.data.items} keyExtractor={(item) => item.id}
                ListHeaderComponent={<Text style={[styles.notice, { color: colors.textMuted }]}>{t('sessionResources.worktreeReadOnly')}</Text>}
                renderItem={({ item }) => row(item.head.branch || item.id, item.isCurrent ? t('sessionResources.currentWorktree') : item.id, 'git-branch-outline', undefined, item.isCurrent)}
              />
                : value.kind === 'diff' && value.data.binary ? <Text style={[styles.message, { color: colors.textMuted }]}>{t('sessionResources.binary')}</Text>
                  : <FlatList<RepositoryDiff['lines'][number]>
                    key={navigationKey} ref={(list) => { scrollTo.current = list ? (options) => list.scrollToOffset(options) : undefined; }}
                    data={value.kind === 'file' ? value.data.content.split('\n').map((content) => ({ content, kind: 'context' as const })) : value.data.lines}
                    keyExtractor={(_, index) => String(index)}
                    onScroll={(event) => offsets.set(navigationKey, event.nativeEvent.contentOffset.y)} onContentSizeChange={restorePosition}
                    ListHeaderComponent={value.kind === 'diff' && value.data.truncated ? <Text style={[styles.notice, { color: colors.noticeText, backgroundColor: colors.notice }]}>{t('sessionResources.truncated')}</Text> : null}
                    renderItem={({ item, index }) => <View style={[styles.codeLine, item.kind === 'addition' ? { backgroundColor: colors.sessionActiveSoft } : item.kind === 'deletion' ? { backgroundColor: colors.errorSoft } : undefined]}>
                      <Text style={[styles.lineNumber, { color: colors.textMuted }]}>{index + 1}</Text><Text selectable style={[styles.codeText, { color: colors.text }]}>{item.content || ' '}</Text>
                    </View>}
                  />}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0 }, toolbar: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 44, paddingHorizontal: 4 },
  path: { flex: 1, fontSize: 14, paddingHorizontal: 8 }, button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  notice: { fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingVertical: 7 }, loading: { flex: 1 }, message: { padding: 20, fontSize: 14, lineHeight: 20 },
  row: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10 },
  rowCopy: { flex: 1, gap: 4 }, rowTitle: { fontSize: 15, fontWeight: '500' }, rowSubtitle: { fontSize: 12, lineHeight: 17 },
  pressed: { opacity: 0.6 }, retry: { minHeight: 44, justifyContent: 'center' },
  codeLine: { flexDirection: 'row', paddingRight: 10, minHeight: 20 }, lineNumber: { width: 42, textAlign: 'right', paddingRight: 10, fontSize: 12, lineHeight: 20 },
  codeText: { flex: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20 },
});
