import { useState } from 'react';
import * as Crypto from 'expo-crypto';
import { router, Stack } from 'expo-router';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ControlPlaneInstanceAction } from '@task-handoff/protocol/control-plane-directory';

import { mobileAiSessionStore } from '../ai-sessions/store';
import { useActiveAiSessions } from '../ai-sessions/use-active-sessions';
import { Screen } from '../components/Screen';
import { EmptyState } from '../components/EmptyState';
import { EmbeddedPaneHeaderOptions } from '../components/EmbeddedPaneHeader';
import { useMobileToast } from '../components/MobileToast';
import { Icon } from '../components/Icon';
import { MenuView, type MenuAction } from '../components/MenuView';
import { useMobileTheme } from '../components/theme';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import { PaneHeaderRestore } from '../master-detail/use-pane-header-restore';
import { InstanceDetailContent } from './InstanceDetailContent';
import { instanceLifecycleActionLabel } from './instance-lifecycle';
import { RESOURCE_NAME_MAX_LENGTH, validateResourceName } from './resource-name';

type RenameTarget = 'instance' | 'node';

export function InstanceDetailScreen({ embeddedHeader = false, instanceId, pane = false }: { embeddedHeader?: boolean; instanceId: string; pane?: boolean }) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const toast = useMobileToast();
  const { actions: aiSessionActions, refresh: refreshAiSessions, state: aiSessionState } = useActiveAiSessions();
  const { controlPlaneId, runInstanceAction, state, updateInstanceName, updateNodeName } = useActiveDirectories();
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [lifecycleAction, setLifecycleAction] = useState<ControlPlaneInstanceAction>();
  const [closingAllSessions, setClosingAllSessions] = useState(false);
  const instance = state.instances.find((candidate) => candidate.id === instanceId);
  const node = instance ? state.nodes.find((candidate) => candidate.id === instance.nodeId) : undefined;
  if (!instance) {
    return <Screen contentContainerStyle={styles.emptyScreen}><EmptyState icon="layers-outline" message={t('instance.notFound')} /></Screen>;
  }

  const activeSessionCount = instance.aiSessions.runningCount + instance.aiSessions.waitingCount;
  const instanceSessions = aiSessionState.snapshot?.instances.find((entry) => entry.instanceId === instance.id)?.aiSessions.sessions.filter((session) => session.actions?.close !== false) ?? [];
  const currentName = renameTarget === 'node' ? node?.name : instance.name;
  const canRename = state.phase === 'ready' && !renaming && !lifecycleAction;
  const openRename = (target: RenameTarget) => {
    const name = target === 'node' ? node?.name : instance.name;
    if (!name || !canRename) return;
    setRenameTarget(target);
    setRenameDraft(name);
    setRenameError('');
  };
  const closeRename = () => {
    if (renaming) return;
    setRenameTarget(undefined);
    setRenameDraft('');
    setRenameError('');
  };
  const submitRename = async () => {
    if (!renameTarget || !currentName || renaming) return;
    const validation = validateResourceName(renameDraft, currentName);
    if (validation) {
      setRenameError(t(validation === 'required' ? 'instance.nameRequired' : validation === 'too-long' ? 'instance.nameTooLong' : 'instance.nameUnchanged', { max: RESOURCE_NAME_MAX_LENGTH }));
      return;
    }
    setRenaming(true);
    setRenameError('');
    try {
      const name = renameDraft.trim();
      if (renameTarget === 'node') await updateNodeName(node!.id, name);
      else await updateInstanceName(instance.id, name);
      setRenameTarget(undefined);
      setRenameDraft('');
    } catch (cause) {
      toast.show({
        detail: cause instanceof Error && cause.message ? cause.message : t('instance.renameFailed'),
        title: t('toast.actionFailed', { action: t(renameTarget === 'node' ? 'instance.editNodeName' : 'instance.editInstanceName') }),
        tone: 'error',
      });
    } finally {
      setRenaming(false);
    }
  };
  const lifecycleActionLabel = (action: ControlPlaneInstanceAction) => instanceLifecycleActionLabel(action, t);
  const lifecycleMenuActions: MenuAction[] = instance.availableActions.map((action) => ({
    id: action,
    image: action === 'start' ? 'play.circle' : action === 'stop' ? 'stop.circle' : 'arrow.clockwise.circle',
    title: lifecycleActionLabel(action),
    attributes: { disabled: Boolean(lifecycleAction), destructive: action === 'stop' },
  }));
  const menuActions: MenuAction[] = [
    ...lifecycleMenuActions,
    { id: 'close-all-sessions', image: 'xmark.circle', title: t(closingAllSessions ? 'sessions.closingAll' : 'sessions.closeAll'), attributes: { destructive: true, disabled: closingAllSessions || !aiSessionActions || !instanceSessions.length || state.phase !== 'ready' } },
    { id: 'rename-instance', image: 'pencil', title: t('instance.editInstanceName'), attributes: { disabled: !canRename } },
    { id: 'rename-node', image: 'server.rack', title: t('instance.editNodeName'), attributes: { disabled: !canRename || !node } },
  ];
  const requestCloseAllSessions = () => {
    if (!aiSessionActions || closingAllSessions || !instanceSessions.length) return;
    Alert.alert(t('sessions.closeAllConfirmTitle'), t('sessions.closeAllConfirmDescription', { count: instanceSessions.length, name: instance.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('sessions.closeAll'), style: 'destructive', onPress: () => {
        setClosingAllSessions(true);
        void aiSessionActions.closeMany(instanceSessions.map((session) => ({ instanceId: instance.id, sessionId: session.id })), Crypto.randomUUID).then(async ({ failed, total }) => {
          await refreshAiSessions().catch(() => undefined);
          toast.show({ title: failed ? t('sessions.closeAllPartial', { failed, total }) : t('sessions.closeAllSuccess', { count: total }), tone: failed ? 'error' : 'success' });
        }).finally(() => setClosingAllSessions(false));
      } },
    ]);
  };
  const executeLifecycleAction = async (action: ControlPlaneInstanceAction) => {
    if (lifecycleAction || !instance.availableActions.includes(action)) return;
    setLifecycleAction(action);
    try {
      await runInstanceAction(instance.id, action);
    } catch (cause) {
      toast.show({
        detail: cause instanceof Error && cause.message ? cause.message : t('instance.actionFailed'),
        title: t('toast.actionFailed', { action: lifecycleActionLabel(action) }),
        tone: 'error',
      });
    } finally {
      setLifecycleAction(undefined);
    }
  };
  const requestLifecycleAction = (action: ControlPlaneInstanceAction) => {
    if (action !== 'stop' && action !== 'restart') {
      void executeLifecycleAction(action);
      return;
    }
    const label = t(action === 'stop' ? 'instance.stop' : 'instance.restart');
    Alert.alert(t('instance.actionConfirmTitle', { action: label, name: instance.name }), t(action === 'stop' ? 'instance.stopConfirmDescription' : 'instance.restartConfirmDescription'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: label, style: action === 'stop' ? 'destructive' : 'default', onPress: () => { void executeLifecycleAction(action); } },
    ]);
  };
  const handleMenuAction = (event: string) => {
    if (instance.availableActions.includes(event as ControlPlaneInstanceAction)) requestLifecycleAction(event as ControlPlaneInstanceAction);
    else if (event === 'close-all-sessions') requestCloseAllSessions();
    else if (event === 'rename-instance') openRename('instance');
    else if (event === 'rename-node') openRename('node');
  };
  const menu = <MenuView
    actions={menuActions}
    onPressAction={({ nativeEvent }) => handleMenuAction(nativeEvent.event)}
    title={t('instance.moreActions')}
  >
    <Pressable accessibilityLabel={t('instance.moreActions')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}>
      <Icon color={colors.primary} name="ellipsis-horizontal" size={23} />
    </Pressable>
  </MenuView>;
  return <>
    {embeddedHeader
      ? <EmbeddedPaneHeaderOptions enabled headerRight={menu} title={instance.name} />
      : <><Stack.Screen options={pane ? { headerRight: () => menu } : { title: instance.name, headerRight: () => menu }} /><PaneHeaderRestore pane={pane} /></>}
    <InstanceDetailContent
      actions={instance.availableActions}
      activeSessionCount={activeSessionCount}
      error={instance.error}
      heartbeat={instance.lastHeartbeatAt ? new Date(instance.lastHeartbeatAt).toLocaleString(locale) : t('instance.notObserved')}
      lifecycleAction={lifecycleAction}
      nodeName={node?.name || instance.nodeId}
      onCreateSession={() => router.push({ pathname: '/sessions/new', params: { instanceId } })}
      onLifecycleAction={requestLifecycleAction}
      onShowHistory={() => router.push({ pathname: '/history/[instanceId]', params: { instanceId } })}
      onShowSessions={() => {
        if (controlPlaneId) mobileAiSessionStore.setScope(controlPlaneId, { kind: 'instance', instanceId });
        router.push({ pathname: '/(tabs)/(main)/inbox', params: { instanceId } });
      }}
      onShowWorktrees={() => router.push({ pathname: '/instances/[instanceId]/worktrees' as never, params: { instanceId } })}
      problemSessionCount={instance.aiSessions.problemCount}
      protocol={instance.protocol.version || t('instance.notReported')}
      protocolCompatible={instance.protocol.compatible}
      protocolWarning={instance.protocol.warning}
      runtime={`${instance.runtime.name || instance.runtime.id}${instance.runtime.type ? ` · ${instance.runtime.type}` : ''}`}
      status={`${instance.status} · ${instance.connectionStatus} · ${instance.health}`}
      statusTone={instance.ready && instance.connectionStatus === 'online' ? 'healthy' : instance.status === 'failed' || instance.status === 'unhealthy' ? 'error' : 'muted'}
      workspace={instance.workspace.path || instance.workspace.status}
    />
    <Modal animationType="fade" onRequestClose={closeRename} transparent visible={Boolean(renameTarget)}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.renameOverlay}>
        <Pressable disabled={renaming} onPress={closeRename} style={styles.renameBackdrop} />
        <View style={[styles.renameDialog, { backgroundColor: colors.surface }]}>
          <Text style={[styles.renameTitle, { color: colors.text }]}>{t(renameTarget === 'node' ? 'instance.editNodeName' : 'instance.editInstanceName')}</Text>
          <TextInput
            accessibilityLabel={t(renameTarget === 'node' ? 'instance.nodeName' : 'instance.instanceName')}
            autoFocus
            editable={!renaming}
            maxLength={RESOURCE_NAME_MAX_LENGTH}
            onChangeText={(value) => { setRenameDraft(value); setRenameError(''); }}
            onSubmitEditing={() => { void submitRename(); }}
            placeholder={t(renameTarget === 'node' ? 'instance.nodeName' : 'instance.instanceName')}
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
            selectTextOnFocus
            style={[styles.renameInput, { backgroundColor: colors.background, borderColor: renameError ? colors.error : colors.border, color: colors.text }]}
            value={renameDraft}
          />
          {renameError ? <Text accessibilityLiveRegion="polite" style={[styles.renameError, { color: colors.error }]}>{renameError}</Text> : null}
          <View style={styles.renameActions}>
            <Pressable disabled={renaming} onPress={closeRename} style={({ pressed }) => [styles.renameAction, pressed && styles.pressed]}><Text style={[styles.renameActionText, { color: colors.textMuted }]}>{t('common.cancel')}</Text></Pressable>
            <Pressable disabled={renaming} onPress={() => { void submitRename(); }} style={({ pressed }) => [styles.renameAction, renaming && styles.disabled, pressed && styles.pressed]}><Text style={[styles.renameActionText, { color: colors.primary }]}>{renaming ? t('instance.renaming') : t('common.save')}</Text></Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  emptyScreen: { flexGrow: 1, justifyContent: 'center' },
  menuButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.45 },
  renameOverlay: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
  renameBackdrop: { backgroundColor: 'rgba(0,0,0,0.35)', bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  renameDialog: { borderRadius: 16, gap: 12, maxWidth: 420, padding: 18, width: '100%' },
  renameTitle: { fontSize: 18, fontWeight: '700', lineHeight: 24 },
  renameInput: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 16, minHeight: 44, paddingHorizontal: 12, paddingVertical: 9 },
  renameError: { fontSize: 13, lineHeight: 18 },
  renameActions: { flexDirection: 'row', justifyContent: 'flex-end' },
  renameAction: { alignItems: 'center', justifyContent: 'center', minHeight: 40, paddingHorizontal: 12 },
  renameActionText: { fontSize: 15, fontWeight: '600' },
});
