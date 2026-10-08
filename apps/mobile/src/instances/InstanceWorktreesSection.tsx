import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { isControlPlaneNotFoundError } from '@task-handoff/control-plane-client';
import type { RepositoryBranches, RepositoryMoveWorktreePreflight, RepositoryWorktree, RepositoryWorktrees } from '@task-handoff/protocol/repository';

import { NewWorktreeDialog } from '../ai-sessions/NewWorktreeDialog';
import type { BranchPickerBranch } from '../ai-sessions/NewSessionBranchPicker';
import { aiSessionFolderOptions, defaultAiSessionFolderId } from '../ai-sessions/new-session-types';
import { useMobileToast } from '../components/MobileToast';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { createMobileControlPlaneClient } from '../control-plane/client';
import { mobileProfileStore, mobileSecureStore } from '../control-plane/runtime';
import { useI18n } from '../i18n';
import { repositoryMoveWorktreeBlockers, repositoryWorktreeCreateBlockers, repositoryWorktreeLabel, repositoryWorktreeMeta, repositoryWorktreeRemoveBlockers } from '../repository/worktree-presentation';
import { invalidateWorktreeInstance, loadWorktreeScope, subscribeToWorktreeForeground } from '../repository/worktree-sync';
import type { MobileNewWorktreeSelection } from '../repository/worktree-selection';

type LoadStatus = 'loading' | 'ready' | 'unsupported' | 'error';

export function InstanceWorktreesSection({ instanceId, nodeId, refreshToken, workspacePath }: { instanceId: string; nodeId: string; refreshToken?: number; workspacePath?: string }) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const toast = useMobileToast();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string>();
  const [worktrees, setWorktrees] = useState<RepositoryWorktrees>();
  const [branches, setBranches] = useState<RepositoryBranches>();
  const [cwdFolderId, setCwdFolderId] = useState<string>();
  const [busyWorktreeId, setBusyWorktreeId] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const resolveClient = useCallback(async () => {
    const profile = await mobileProfileStore.active();
    if (!profile) throw new Error(t('instance.notFound'));
    return createMobileControlPlaneClient(profile, mobileSecureStore).api;
  }, [t]);

  const loadWorktrees = useCallback(async () => {
    const client = await resolveClient();
    const { cwdFolderId: nextCwdFolderId } = await loadWorktreeScope({ kind: 'management-scope', instanceId, variant: `${nodeId}\u0001${workspacePath ?? ''}` }, async () => {
      const [folders, source] = await Promise.all([
        client.resources.nodeLocalFolders(nodeId),
        client.resources.instanceWorkspaceSource(instanceId).catch(() => undefined),
      ]);
      const options = aiSessionFolderOptions(source, workspacePath, folders, locale);
      const folderId = defaultAiSessionFolderId(source, workspacePath, folders);
      return { cwdFolderId: options.find((folder) => folder.id === folderId)?.cwdFolderId };
    });
    const target = { instanceId, ...(nextCwdFolderId ? { cwdFolderId: nextCwdFolderId } : {}) };
    const { worktrees: nextWorktrees, branches: nextBranches } = await loadWorktreeScope(
      { kind: 'management', instanceId, cwdFolderId: nextCwdFolderId },
      async () => {
        const [worktreesResult, branchesResult] = await Promise.all([
          client.repository.worktrees(target),
          client.repository.branches(target),
        ]);
        return { worktrees: worktreesResult, branches: branchesResult };
      },
    );
    return { cwdFolderId: nextCwdFolderId, worktrees: nextWorktrees, branches: nextBranches };
  }, [instanceId, nodeId, resolveClient, workspacePath]);

  const applyWorktreeData = useCallback((data: Awaited<ReturnType<typeof loadWorktrees>>) => {
    setCwdFolderId(data.cwdFolderId);
    setWorktrees(data.worktrees);
    setBranches(data.branches);
    setStatus('ready');
    setError(undefined);
  }, []);

  const applyWorktreeError = useCallback((cause: unknown) => {
    // Compatibility for v0.0.21: older instances only expose session-scoped repository routes.
    if (isControlPlaneNotFoundError(cause)) {
      setStatus('unsupported');
      return;
    }
    setStatus('error');
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refresh = useCallback(async () => {
    setStatus((current) => current === 'ready' ? current : 'loading');
    setError(undefined);
    try {
      applyWorktreeData(await loadWorktrees());
    } catch (cause) {
      applyWorktreeError(cause);
    }
  }, [applyWorktreeData, applyWorktreeError, loadWorktrees]);

  useEffect(() => {
    let live = true;
    void loadWorktrees().then(
      (data) => { if (live) applyWorktreeData(data); },
      (cause) => { if (live) applyWorktreeError(cause); },
    );
    return () => { live = false; };
  }, [applyWorktreeData, applyWorktreeError, loadWorktrees, refreshToken]);
  useEffect(() => subscribeToWorktreeForeground(() => { void refresh(); }), [refresh]);

  const reportError = useCallback((cause: unknown, fallback: string) => {
    toast.show({ detail: cause instanceof Error ? cause.message : fallback, title: t('toast.actionFailed', { action: t('repository.worktrees.sectionTitle') }), tone: 'error' });
  }, [t, toast]);

  const target = { instanceId, ...(cwdFolderId ? { cwdFolderId } : {}) };

  const createWorktree = async (selection: MobileNewWorktreeSelection) => {
    const snapshotId = branches?.snapshotId;
    if (!snapshotId || creating) return;
    setCreating(true);
    try {
      const client = await resolveClient();
      await client.repository.createWorktree(target, selection.mode === 'new-branch'
        ? { mode: 'new-branch', branchName: selection.branchName, startRef: selection.startRef, expectedSnapshotId: snapshotId }
        : { mode: 'existing-branch', branchName: selection.branchName, expectedSnapshotId: snapshotId });
      invalidateWorktreeInstance(instanceId);
      setDialogOpen(false);
      await refresh();
    } catch (cause) {
      reportError(cause, t('sessions.worktreeCreateFailed'));
    } finally {
      setCreating(false);
    }
  };

  const removeWorktree = async (worktree: RepositoryWorktree) => {
    const snapshotId = worktrees?.snapshotId;
    if (!snapshotId || busyWorktreeId) return;
    setBusyWorktreeId(worktree.id);
    try {
      const client = await resolveClient();
      const result = await client.repository.removeWorktree(target, { worktreeId: worktree.id, expectedSnapshotId: snapshotId, confirm: true });
      invalidateWorktreeInstance(instanceId);
      await refresh();
      toast.show({ title: t(result.branchRetained ? 'repository.worktrees.removedRetained' : 'repository.worktrees.removed'), tone: 'success' });
    } catch (cause) {
      reportError(cause, t('repository.worktrees.removeFailed'));
      invalidateWorktreeInstance(instanceId);
      await refresh();
    } finally {
      setBusyWorktreeId(undefined);
    }
  };

  const confirmRemove = (worktree: RepositoryWorktree) => {
    if (!worktree.canRemove || busyWorktreeId) return;
    Alert.alert(t('repository.worktrees.removeTitle'), t('repository.worktrees.removeDescription'), [
      { style: 'cancel', text: t('common.cancel') },
      { onPress: () => { void removeWorktree(worktree); }, style: 'destructive', text: t('repository.worktrees.remove') },
    ]);
  };

  const moveWorktree = async (worktree: RepositoryWorktree, preflight: RepositoryMoveWorktreePreflight) => {
    const snapshotId = worktrees?.snapshotId;
    if (!snapshotId || busyWorktreeId) return;
    setBusyWorktreeId(worktree.id);
    try {
      const client = await resolveClient();
      const result = await client.repository.moveWorktreeToMain(target, { worktreeId: preflight.worktreeId, expectedSnapshotId: snapshotId, confirm: true });
      invalidateWorktreeInstance(instanceId);
      await refresh();
      toast.show({ title: t(result.carriedChanges ? 'repository.worktrees.movedWithChanges' : 'repository.worktrees.moved'), tone: 'success' });
    } catch (cause) {
      reportError(cause, t('repository.worktrees.moveFailed'));
      invalidateWorktreeInstance(instanceId);
      await refresh();
    } finally {
      setBusyWorktreeId(undefined);
    }
  };

  const requestMoveToMain = async (worktree: RepositoryWorktree) => {
    if (worktree.isMain || busyWorktreeId) return;
    setBusyWorktreeId(worktree.id);
    try {
      const client = await resolveClient();
      const preflight = await client.repository.moveWorktreeToMainPreflight(target, { worktreeId: worktree.id });
      setBusyWorktreeId(undefined);
      const blockers = repositoryMoveWorktreeBlockers(preflight.blockers, t);
      if (!preflight.canMove) {
        Alert.alert(t('repository.worktrees.moveToMainTitle'), blockers.join('\n') || t('repository.worktrees.blockers.main'), [{ text: t('common.confirm') }]);
        return;
      }
      const carried = preflight.targetChanges.unstaged + preflight.targetChanges.staged + preflight.targetChanges.untracked + preflight.targetChanges.conflicts;
      Alert.alert(t('repository.worktrees.moveToMainTitle'), [
        t('repository.worktrees.moveToMainDescription'),
        carried ? t('repository.worktrees.moveToMainCarry', { count: carried }) : t('repository.worktrees.moveToMainClean'),
      ].join('\n\n'), [
        { style: 'cancel', text: t('common.cancel') },
        { onPress: () => { void moveWorktree(worktree, preflight); }, text: t('repository.worktrees.moveToMainConfirm') },
      ]);
    } catch (cause) {
      reportError(cause, t('repository.worktrees.moveFailed'));
      setBusyWorktreeId(undefined);
    } finally {
      setBusyWorktreeId((current) => current === worktree.id ? undefined : current);
    }
  };

  const dialogBranches: BranchPickerBranch[] = (branches?.branches || [])
    .filter((branch) => branch.kind === 'local')
    .map((branch) => ({
      name: branch.name,
      current: branch.current,
      currentFolderSelectable: branch.current,
      worktreeSelectable: true,
      worktreeCheckout: branch.checkedOutWorktreeIds.length ? 'detached' as const : 'attached' as const,
    }));

  return <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        <Text style={[styles.title, { color: colors.text }]}>{t('repository.worktrees.sectionTitle')}</Text>
        <Text style={[styles.description, { color: colors.textMuted }]}>{worktrees ? t('repository.worktrees.count', { count: worktrees.items.length }) : t('repository.worktrees.sectionDescription')}</Text>
      </View>
      <Pressable accessibilityLabel={t('repository.worktrees.retry')} accessibilityRole="button" hitSlop={8} onPress={() => { void refresh(); }} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
        <SystemIcon android="refresh" color={colors.textMuted} ios="arrow.clockwise" size={16} />
      </Pressable>
      <Pressable accessibilityLabel={t('repository.worktrees.new')} accessibilityRole="button" disabled={status !== 'ready'} hitSlop={8} onPress={() => setDialogOpen(true)} style={({ pressed }) => [styles.iconButton, status !== 'ready' && styles.disabled, pressed && styles.pressed]}>
        <SystemIcon android="add" color={colors.primary} ios="plus" size={18} />
      </Pressable>
    </View>

    {status === 'loading' ? <View style={styles.state}><ActivityIndicator color={colors.textMuted} size="small" /></View> : null}
    {status === 'unsupported' ? <Text style={[styles.stateText, { color: colors.textMuted }]}>{t('repository.worktrees.unsupported')}</Text> : null}
    {status === 'error' ? <View style={styles.state}>
      <Text style={[styles.stateText, { color: colors.error }]}>{error || t('repository.worktrees.loadError')}</Text>
      <Pressable accessibilityRole="button" onPress={() => { void refresh(); }}><Text style={[styles.retry, { color: colors.primary }]}>{t('repository.worktrees.retry')}</Text></Pressable>
    </View> : null}
    {status === 'ready' && worktrees ? (worktrees.items.length ? worktrees.items.map((worktree) => {
      const createBlockers = repositoryWorktreeCreateBlockers(worktree, t);
      const removeBlockers = repositoryWorktreeRemoveBlockers(worktree, t);
      const busy = busyWorktreeId === worktree.id;
      const removable = worktree.canRemove && !removeBlockers.length;
      return <View key={worktree.id} style={[styles.row, { borderTopColor: colors.border }]}>
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.text }]}>{repositoryWorktreeLabel(worktree, t)}</Text>
          <Text numberOfLines={1} style={[styles.rowMeta, { color: colors.textMuted }]}>{repositoryWorktreeMeta(worktree, t)}</Text>
          {createBlockers.length ? <Text numberOfLines={2} style={[styles.rowBlocker, { color: colors.textMuted }]}>{createBlockers.join(' · ')}</Text> : null}
          {!removable && removeBlockers.length ? <Text numberOfLines={2} style={[styles.rowBlocker, { color: colors.error }]}>{removeBlockers.join(' · ')}</Text> : null}
          <View style={styles.rowActions}>
            <Pressable accessibilityLabel={t('repository.worktrees.remove')} accessibilityRole="button" accessibilityState={{ disabled: !removable || busy }} disabled={!removable || busy} onPress={() => confirmRemove(worktree)} style={({ pressed }) => [styles.action, { borderColor: colors.border }, (!removable || busy) && styles.disabled, pressed && styles.pressed]}>
              <Text style={[styles.actionLabel, { color: removable ? colors.error : colors.textMuted }]}>{t('repository.worktrees.remove')}</Text>
            </Pressable>
            <Pressable accessibilityLabel={t('repository.worktrees.moveToMain')} accessibilityRole="button" accessibilityState={{ disabled: worktree.isMain || busy }} disabled={worktree.isMain || busy} onPress={() => { void requestMoveToMain(worktree); }} style={({ pressed }) => [styles.action, { borderColor: colors.border }, (worktree.isMain || busy) && styles.disabled, pressed && styles.pressed]}>
              <Text style={[styles.actionLabel, { color: worktree.isMain ? colors.textMuted : colors.primary }]}>{busy ? t('repository.worktrees.moveChecking') : t('repository.worktrees.moveToMain')}</Text>
            </Pressable>
          </View>
        </View>
      </View>;
    }) : <Text style={[styles.stateText, { color: colors.textMuted }]}>{t('repository.worktrees.empty')}</Text>) : null}

    <NewWorktreeDialog
      branches={dialogBranches}
      busy={creating}
      confirmLabel={t('sessions.useNewWorktree')}
      description={t('sessions.newWorktreeDescription')}
      onCancel={() => setDialogOpen(false)}
      onConfirm={(selection) => { void createWorktree(selection); }}
      title={t('sessions.newWorktree')}
      visible={dialogOpen}
    />
  </View>;
}

const styles = StyleSheet.create({
  section: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingVertical: 12 },
  headerCopy: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  description: { fontSize: 12, lineHeight: 17 },
  iconButton: { alignItems: 'center', height: 32, justifyContent: 'center', width: 32 },
  state: { alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 20 },
  stateText: { fontSize: 13, lineHeight: 18, paddingHorizontal: 14, paddingVertical: 14 },
  retry: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  row: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
  rowCopy: { gap: 3 },
  rowTitle: { fontSize: 14, fontWeight: '500', lineHeight: 20 },
  rowMeta: { fontSize: 12, lineHeight: 17 },
  rowBlocker: { fontSize: 12, lineHeight: 17 },
  rowActions: { flexDirection: 'row', gap: 8, paddingTop: 6 },
  action: { alignItems: 'center', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center', minHeight: 30, paddingHorizontal: 10 },
  actionLabel: { fontSize: 12, fontWeight: '500', lineHeight: 16 },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.75 },
});
