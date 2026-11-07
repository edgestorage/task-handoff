import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { repositoryFileLocation, type ControlPlaneClient, type RepositorySessionTarget } from '@task-handoff/control-plane-client';
import type { RepositoryChanges, RepositoryContext, RepositoryDirectoryListing, RepositoryFileContent, RepositoryWorktrees } from '@task-handoff/protocol/repository';

import { useResourceBack } from '../components/resource-back';
import { Icon } from '../components/Icon';
import { useMobileToast } from '../components/MobileToast';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { RepositoryChangesReview } from './RepositoryChangesReview';
import { RepositoryFilePreview, isRepositoryMarkdownPath, type RepositoryMarkdownView } from './RepositoryFilePreview';
import { repositoryFailureCopy, repositoryFailureKind } from './repositoryError';
import { repositoryViewMemory, updateRepositoryViewNavigation } from './view-memory';
import type { RepositoryResourcePage } from '../ai-sessions/resource-workspace-model';

type RepositoryRead =
  | { kind: 'directory'; data: RepositoryDirectoryListing }
  | { kind: 'file'; data: RepositoryFileContent }
  | { kind: 'changes'; context?: RepositoryContext; data: RepositoryChanges }
  | { kind: 'worktrees'; data: RepositoryWorktrees };

function directoriesForFile(path: string) {
  let current = '';
  return ['', ...path.split('/').slice(0, -1).map((segment) => current = current ? `${current}/${segment}` : segment)];
}

/** Explicit, abortable reads. The repository protocol currently has no change-event stream. */
export function RepositoryResourceView({ active, client, cwdFolderId, fileRequest, onOpenBuiltinBrowser, onOpenFile, onOpenFiles, page, ready, refreshToken = 0, target, workspaceIdentity }: {
  active: boolean;
  client?: ControlPlaneClient;
  cwdFolderId?: string;
  fileRequest?: { basePath?: string; href: string; id: number };
  onOpenBuiltinBrowser?(url: string): void | Promise<void>;
  onOpenFile?(href: string, basePath?: string): void | Promise<void>;
  onOpenFiles?(): void;
  page: RepositoryResourcePage;
  ready: boolean;
  refreshToken?: number;
  target: RepositorySessionTarget;
  workspaceIdentity: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const toast = useMobileToast();
  const memoryKey = JSON.stringify([workspaceIdentity, page]);
  const memory = useMemo(() => repositoryViewMemory(memoryKey), [memoryKey]);
  const [navigationState, setNavigationState] = useState({ memory, value: memory.navigation });
  const navigation = navigationState.memory === memory ? navigationState.value : memory.navigation;
  const { directories, fileLine, filePath } = navigation;
  const navigate = useCallback((update: (current: typeof navigation) => typeof navigation) => {
    const next = updateRepositoryViewNavigation(memoryKey, update);
    setNavigationState({ memory, value: next });
  }, [memory, memoryKey]);
  const [refresh, setRefresh] = useState(0);
  const [handledFileRequest, setHandledFileRequest] = useState<number>();
  const fileViewKey = filePath ? `${filePath}\0${fileLine ?? ''}` : '';
  const [markdownViewState, setMarkdownViewState] = useState<{ key: string; value: RepositoryMarkdownView }>({ key: fileViewKey, value: 'preview' });
  const markdownView = markdownViewState.key === fileViewKey ? markdownViewState.value : (fileLine ? 'source' : 'preview');
  const setMarkdownView = useCallback((value: RepositoryMarkdownView) => setMarkdownViewState({ key: fileViewKey, value }), [fileViewKey]);
  const [result, setResult] = useState<{ key: string; value?: RepositoryRead; error?: { cause: unknown } }>();
  const scrollTo = useRef<((options: { offset: number; animated: boolean }) => void) | undefined>(undefined);
  const offsets = memory.offsets;
  const path = directories.at(-1) || '';
  const pendingFileRequest = page === 'files' && fileRequest?.id !== handledFileRequest ? fileRequest : undefined;
  const key = JSON.stringify([workspaceIdentity, page, path, filePath, refresh, refreshToken]);
  const request = useRef(0);

  useEffect(() => {
    if (!active || !ready || !client || !pendingFileRequest) return;
    const abort = new AbortController();
    void client.repository.context(target, { signal: abort.signal }).then((context) => {
      if (abort.signal.aborted) return;
      const location = repositoryFileLocation(pendingFileRequest.href, {
        ...context,
        cwdRelativePath: pendingFileRequest.basePath ?? context.cwdRelativePath,
      });
      if (!location) {
        setHandledFileRequest(pendingFileRequest.id);
        toast.show({ title: t('sessionResources.openFileFailed'), tone: 'error' });
        return;
      }
      navigate((current) => ({
        ...current,
        directories: directoriesForFile(location.path),
        fileLine: location.line,
        filePath: location.path,
      }));
      setHandledFileRequest(pendingFileRequest.id);
    }).catch(() => {
      if (abort.signal.aborted) return;
      setHandledFileRequest(pendingFileRequest.id);
      toast.show({ title: t('sessionResources.openFileFailed'), tone: 'error' });
    });
    return () => abort.abort();
  }, [active, client, navigate, pendingFileRequest, ready, t, target, toast]);

  useEffect(() => {
    if (!active || !ready || !client || pendingFileRequest) return;
    const abort = new AbortController();
    const generation = ++request.current;
    const read = async (): Promise<RepositoryRead> => {
      if (page === 'files') {
        return filePath ? { kind: 'file', data: await client.repository.file(target, filePath, { signal: abort.signal }) }
          : { kind: 'directory', data: await client.repository.directory(target, path, { signal: abort.signal }) };
      }
      if (page === 'changes') {
        const contextRead = client.repository.context
          ? client.repository.context(target, { signal: abort.signal }).catch(() => undefined)
          : Promise.resolve<RepositoryContext | undefined>(undefined);
        const [data, context] = await Promise.all([
          client.repository.changes(target, { signal: abort.signal }),
          contextRead,
        ]);
        return { context, data, kind: 'changes' };
      }
      return { kind: 'worktrees', data: await client.repository.worktrees({ instanceId: target.instanceId, cwdFolderId, legacySession: target }, { signal: abort.signal }) };
    };
    void read().then((value) => {
      if (!abort.signal.aborted && request.current === generation) setResult({ key, value });
    }).catch((error: unknown) => {
      if (!abort.signal.aborted && request.current === generation) setResult({ error: { cause: error }, key });
    });
    return () => abort.abort();
  // Keys encode the complete request target. A new workspace is mounted with a new identity by the owner.
  }, [active, client, cwdFolderId, filePath, key, page, path, pendingFileRequest, ready, target]);

  const goBack = useCallback(() => {
    if (filePath) { navigate((current) => ({ ...current, fileLine: undefined, filePath: undefined })); return true; }
    if (page === 'files' && directories.length > 1) { navigate((current) => ({ ...current, directories: current.directories.slice(0, -1) })); return true; }
    return false;
  }, [directories.length, filePath, navigate, page]);
  useResourceBack(active && Boolean(filePath || directories.length > 1), goBack);
  const value = result?.key === key ? result.value : undefined;
  const failure = result?.key === key ? result.error : undefined;
  const failurePresentation = failure ? repositoryFailureCopy(repositoryFailureKind(failure.cause), t) : undefined;
  const navigationKey = `${page}:${filePath || path}`;
  const label = filePath || path || t(`sessionResources.${page}`);
  const backAvailable = Boolean(filePath || directories.length > 1);
  const restorePosition = () => {
    const offset = offsets.get(navigationKey);
    if (offset) scrollTo.current?.({ offset, animated: false });
  };
  const openChangesFile = useCallback((pathToOpen: string) => {
    if (onOpenFile) {
      void Promise.resolve(onOpenFile(pathToOpen, '')).catch(() => toast.show({ title: t('sessionResources.openFileFailed'), tone: 'error' }));
      return;
    }
    toast.show({ title: t('sessionResources.openFileFailed'), tone: 'error' });
  }, [onOpenFile, t, toast]);
  const openLinkedFile = useCallback((href: string, basePath: string) => {
    if (onOpenFile) return onOpenFile(href, basePath);
    toast.show({ title: t('sessionResources.openFileFailed'), tone: 'error' });
  }, [onOpenFile, t, toast]);
  const row = (title: string, subtitle: string | undefined, icon: 'folder-outline' | 'document-text-outline' | 'git-branch-outline', onPress?: () => void, selected = false) => <Pressable
    accessibilityRole={onPress ? 'button' : undefined} accessibilityState={{ selected }} disabled={!onPress}
    onPress={onPress} style={({ pressed }) => [styles.row, { borderBottomColor: colors.border }, pressed && styles.pressed]}
  >
    <Icon color={selected ? colors.primary : colors.textMuted} name={icon} size={20} />
    <View style={styles.rowCopy}><Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>{subtitle ? <Text style={[styles.rowSubtitle, { color: colors.textMuted }]}>{subtitle}</Text> : null}</View>
    {selected ? <Icon color={colors.primary} name="checkmark" /> : onPress ? <Icon color={colors.textMuted} name="chevron-forward" size={16} /> : null}
  </Pressable>;

  if (page === 'changes') return <RepositoryChangesReview
    active={active}
    changes={value?.kind === 'changes' ? value.data : undefined}
    client={client}
    context={value?.kind === 'changes' ? value.context : undefined}
    failure={failure?.cause}
    onOpenFile={openChangesFile}
    onOpenFiles={() => onOpenFiles?.()}
    onRefresh={() => setRefresh((current) => current + 1)}
    ready={ready}
    target={target}
  />;

  const isMarkdown = Boolean(filePath && isRepositoryMarkdownPath(filePath));
  return <View style={styles.root}>
    <View style={[styles.toolbar, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
      {backAvailable ? <Pressable accessibilityLabel={t('sessionResources.back')} accessibilityRole="button" onPress={goBack} style={styles.button}><Icon name="chevron-back" color={colors.primary} /></Pressable> : null}
      <Text accessibilityLabel={label} numberOfLines={1} style={[styles.path, { color: colors.text }]}>{label}</Text>
      {isMarkdown ? <View accessibilityLabel={t('sessionResources.markdownView')} style={[styles.markdownToggle, { backgroundColor: colors.surfaceInset, borderColor: colors.workbenchCardBorder }]}>
        {(['preview', 'source'] as const).map((mode) => {
          const selected = markdownView === mode;
          return <Pressable accessibilityRole="tab" accessibilityState={{ selected }} key={mode} onPress={() => setMarkdownView(mode)} style={[styles.markdownOption, selected && { backgroundColor: colors.surface }]}><Text style={[styles.markdownOptionText, { color: selected ? colors.text : colors.textMuted }]}>{t(`sessionResources.markdown.${mode}`)}</Text></Pressable>;
        })}
      </View> : <View accessible accessibilityLabel={t('sessionResources.snapshot')} style={[styles.readOnlyBadge, { backgroundColor: colors.surfaceInset }]}>
        <Icon color={colors.textMuted} name="lock-closed-outline" size={12} />
        <Text style={[styles.readOnlyText, { color: colors.textMuted }]}>{t('sessionResources.snapshotBadge')}</Text>
      </View>}
      <Pressable accessibilityLabel={t('sessionResources.refresh')} accessibilityRole="button" disabled={!ready} onPress={() => setRefresh((current) => current + 1)} style={styles.button}><Icon name="refresh" color={ready ? colors.primary : colors.textMuted} /></Pressable>
    </View>
    {!ready ? <View style={styles.state}>
      <View style={[styles.stateIcon, { backgroundColor: colors.surfaceInset }]}><Icon color={colors.textMuted} name="cloud-offline-outline" size={24} /></View>
      <Text style={[styles.stateDetail, { color: colors.textMuted }]}>{t('sessionResources.unavailable')}</Text>
    </View>
      : failurePresentation ? <View style={styles.state} testID="repository-error">
        <View style={[styles.stateIcon, { backgroundColor: colors.errorSoft }]}><Icon color={colors.error} name={failurePresentation.icon} size={24} /></View>
        <Text style={[styles.stateTitle, { color: colors.text }]}>{failurePresentation.title}</Text>
        <Text style={[styles.stateDetail, { color: colors.textMuted }]}>{failurePresentation.detail}</Text>
        <Pressable accessibilityRole="button" onPress={() => setRefresh((current) => current + 1)} style={({ pressed }) => [styles.retryButton, { backgroundColor: colors.primaryButton }, pressed && styles.pressed]}><Text style={styles.retryText}>{t('common.retry')}</Text></Pressable>
      </View>
        : !value ? <ActivityIndicator style={styles.loading} />
          : value.kind === 'file' ? <RepositoryFilePreview
            colors={colors}
            content={value.data.content}
            line={fileLine}
            markdownView={markdownView}
            onOpenBuiltinBrowser={onOpenBuiltinBrowser}
            onOpenFile={openLinkedFile}
            path={value.data.path}
          />
            : value.kind === 'directory' ? <FlatList
              key={navigationKey} ref={(list) => { scrollTo.current = list ? (options) => list.scrollToOffset(options) : undefined; }} data={value.data.entries} keyExtractor={(item) => item.path}
              onScroll={(event) => offsets.set(navigationKey, event.nativeEvent.contentOffset.y)} onContentSizeChange={restorePosition}
              ListEmptyComponent={<Text style={[styles.message, { color: colors.textMuted }]}>{t('sessionResources.emptyDirectory')}</Text>}
              renderItem={({ item }) => row(item.name, item.kind === 'directory' ? undefined : item.kind, item.traversable ? 'folder-outline' : 'document-text-outline', item.traversable
                ? () => navigate((current) => ({ ...current, directories: [...current.directories, item.path], fileLine: undefined, filePath: undefined }))
                : () => navigate((current) => ({ ...current, fileLine: undefined, filePath: item.path })))}
            />
              : value.kind === 'worktrees' ? <FlatList data={value.data.items} keyExtractor={(item) => item.id}
                ListHeaderComponent={<View style={[styles.inlineNotice, { borderBottomColor: colors.border }]}><Icon color={colors.textMuted} name="information-circle-outline" size={14} /><Text style={[styles.inlineNoticeText, { color: colors.textMuted }]}>{t('sessionResources.worktreeReadOnly')}</Text></View>}
                renderItem={({ item }) => row(item.head.branch || item.id, item.isCurrent ? t('sessionResources.currentWorktree') : item.id, 'git-branch-outline', undefined, item.isCurrent)}
              /> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0 }, toolbar: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 44, paddingHorizontal: 4 },
  path: { flex: 1, fontSize: 14, paddingHorizontal: 8 }, button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  readOnlyBadge: { alignItems: 'center', borderRadius: 9, flexDirection: 'row', gap: 4, marginRight: 2, minHeight: 24, paddingHorizontal: 7 },
  readOnlyText: { fontSize: 12, fontWeight: '400', lineHeight: 16 },
  markdownToggle: { alignItems: 'center', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 2, marginHorizontal: 4, padding: 2 },
  markdownOption: { alignItems: 'center', borderRadius: 5, justifyContent: 'center', minHeight: 24, paddingHorizontal: 7 },
  markdownOptionText: { fontSize: 12, fontWeight: '400', lineHeight: 16 },
  loading: { flex: 1 }, message: { padding: 20, fontSize: 14, lineHeight: 20 },
  inlineNotice: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 7, paddingHorizontal: 12, paddingVertical: 8 },
  inlineNoticeText: { flex: 1, fontSize: 12, lineHeight: 17 },
  state: { alignItems: 'center', flex: 1, gap: 9, justifyContent: 'center', padding: 24 },
  stateIcon: { alignItems: 'center', borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },
  stateTitle: { fontSize: 16, fontWeight: '500', lineHeight: 22, textAlign: 'center' },
  stateDetail: { fontSize: 13, lineHeight: 19, maxWidth: 320, textAlign: 'center' },
  retryButton: { alignItems: 'center', borderRadius: 10, justifyContent: 'center', marginTop: 3, minHeight: 44, minWidth: 104, paddingHorizontal: 18 },
  retryText: { color: '#ffffff', fontSize: 15, fontWeight: '500', lineHeight: 20 },
  row: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10 },
  rowCopy: { flex: 1, gap: 4 }, rowTitle: { fontSize: 15, fontWeight: '500' }, rowSubtitle: { fontSize: 12, lineHeight: 17 },
  pressed: { opacity: 0.6 },
});
