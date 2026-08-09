import { useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ControlPlaneInstanceAction } from '@task-handoff/protocol/control-plane-directory';

import { mobileAiSessionStore } from '../../src/ai-sessions/store';
import { Screen } from '../../src/components/Screen';
import { EmptyState } from '../../src/components/EmptyState';
import { useMobileToast } from '../../src/components/MobileToast';
import { SystemIcon } from '../../src/components/SystemIcon';
import { useMobileTheme } from '../../src/components/theme';
import { useActiveDirectories } from '../../src/directories/use-directories';
import { InstanceOverview } from '../../src/instances/InstanceNativeSections';
import { RESOURCE_NAME_MAX_LENGTH, validateResourceName } from '../../src/instances/resource-name';
import { useI18n } from '../../src/i18n';

type RenameTarget = 'instance' | 'node';
const PRIMARY_LIFECYCLE_ACTIONS = ['start', 'stop', 'restart'] as const;

export default function InstanceDirectoryDetailRoute() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const toast = useMobileToast();
  const { instanceId } = useLocalSearchParams<{ instanceId: string }>();
  const { controlPlaneId, runInstanceAction, state, updateInstanceName, updateNodeName } = useActiveDirectories();
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [lifecycleAction, setLifecycleAction] = useState<ControlPlaneInstanceAction>();
  const instance = state.instances.find((candidate) => candidate.id === instanceId);
  const node = instance ? state.nodes.find((candidate) => candidate.id === instance.nodeId) : undefined;
  if (!instance) {
    return <Screen contentContainerStyle={styles.emptyScreen}><EmptyState icon={{ android: 'deployed_code', ios: 'shippingbox' }} message={t('instance.notFound')} /></Screen>;
  }

  const activeSessionCount = instance.aiSessions.runningCount + instance.aiSessions.waitingCount;
  const statusColor = instance.ready && instance.connectionStatus === 'online' ? '#34c759' : instance.status === 'failed' || instance.status === 'unhealthy' ? colors.error : colors.textMuted;
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
  const lifecycleMenuActions: MenuAction[] = instance.availableActions.map((action) => ({
    id: action,
    image: action === 'start' ? 'play.circle' : action === 'stop' ? 'stop.circle' : 'arrow.clockwise.circle',
    title: t(action === 'start' ? 'instance.start' : action === 'stop' ? 'instance.stop' : action === 'restart' ? 'instance.restart' : 'instance.retryImage'),
    attributes: { disabled: Boolean(lifecycleAction) || state.phase !== 'ready', destructive: action === 'stop' },
  }));
  const menuActions: MenuAction[] = [
    ...lifecycleMenuActions,
    { id: 'rename-instance', image: 'pencil', title: t('instance.editInstanceName'), attributes: { disabled: !canRename } },
    { id: 'rename-node', image: 'server.rack', title: t('instance.editNodeName'), attributes: { disabled: !canRename || !node } },
  ];
  const lifecycleActionLabel = (action: ControlPlaneInstanceAction) => t(
    action === 'start' ? 'instance.start' : action === 'stop' ? 'instance.stop' : action === 'restart' ? 'instance.restart' : 'instance.retryImage',
  );
  const executeLifecycleAction = async (action: ControlPlaneInstanceAction) => {
    if (lifecycleAction || state.phase !== 'ready' || !instance.availableActions.includes(action)) return;
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
  return <>
    <Stack.Screen options={{
      title: instance.name,
      headerRight: () => <MenuView
        actions={menuActions}
        onPressAction={({ nativeEvent }) => {
          if (instance.availableActions.includes(nativeEvent.event as ControlPlaneInstanceAction)) requestLifecycleAction(nativeEvent.event as ControlPlaneInstanceAction);
          else if (nativeEvent.event === 'rename-instance') openRename('instance');
          else if (nativeEvent.event === 'rename-node') openRename('node');
        }}
        title={t('instance.moreActions')}
      >
        <Pressable accessibilityLabel={t('instance.moreActions')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}>
          <SystemIcon android="more_horiz" color={colors.primary} ios="ellipsis.circle" size={23} />
        </Pressable>
      </MenuView>,
    }} />
    <Screen>
      <View style={[styles.statusSummary, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
        {lifecycleAction ? <ActivityIndicator color={colors.primary} size="small" /> : <View style={[styles.statusDot, { backgroundColor: statusColor }]} />}
        <Text style={[styles.statusText, { color: colors.textMuted }]}>{instance.status} · {instance.connectionStatus} · {instance.health}</Text>
      </View>

      <View accessibilityRole="toolbar" style={[styles.lifecycleToolbar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {PRIMARY_LIFECYCLE_ACTIONS.map((action) => {
          const enabled = state.phase === 'ready' && !lifecycleAction && instance.availableActions.includes(action);
          const destructive = action === 'stop';
          return <Pressable
            accessibilityLabel={lifecycleActionLabel(action)}
            accessibilityRole="button"
            accessibilityState={{ disabled: !enabled, busy: lifecycleAction === action }}
            disabled={!enabled}
            key={action}
            onPress={() => requestLifecycleAction(action)}
            style={({ pressed }) => [styles.lifecycleButton, !enabled && styles.lifecycleButtonDisabled, pressed && styles.pressed]}
          >
            {lifecycleAction === action
              ? <ActivityIndicator color={colors.primary} size="small" />
              : <SystemIcon
                android={action === 'start' ? 'play_circle' : action === 'stop' ? 'stop_circle' : 'refresh'}
                color={enabled ? destructive ? colors.error : colors.primary : colors.textMuted}
                ios={action === 'start' ? 'play.circle.fill' : action === 'stop' ? 'stop.circle.fill' : 'arrow.clockwise.circle.fill'}
                size={22}
              />}
            <Text style={[styles.lifecycleButtonText, { color: enabled ? destructive ? colors.error : colors.primary : colors.textMuted }]}>{lifecycleActionLabel(action)}</Text>
          </Pressable>;
        })}
        {instance.availableActions.includes('retry-image') ? <Pressable
          accessibilityLabel={lifecycleActionLabel('retry-image')}
          accessibilityRole="button"
          accessibilityState={{ disabled: Boolean(lifecycleAction) || state.phase !== 'ready', busy: lifecycleAction === 'retry-image' }}
          disabled={Boolean(lifecycleAction) || state.phase !== 'ready'}
          onPress={() => requestLifecycleAction('retry-image')}
          style={({ pressed }) => [styles.lifecycleButton, (Boolean(lifecycleAction) || state.phase !== 'ready') && styles.lifecycleButtonDisabled, pressed && styles.pressed]}
        >
          {lifecycleAction === 'retry-image' ? <ActivityIndicator color={colors.primary} size="small" /> : <SystemIcon android="refresh" color={colors.primary} ios="arrow.clockwise.circle.fill" size={22} />}
          <Text style={[styles.lifecycleButtonText, { color: colors.primary }]}>{lifecycleActionLabel('retry-image')}</Text>
        </Pressable> : null}
      </View>

      <InstanceOverview
        activeSessionCount={activeSessionCount}
        heartbeat={instance.lastHeartbeatAt ? new Date(instance.lastHeartbeatAt).toLocaleString(locale) : t('instance.notObserved')}
        nodeName={node?.name || instance.nodeId}
        onCreateSession={() => router.push({ pathname: '/sessions/new', params: { instanceId } })}
        onShowHistory={() => router.push({ pathname: '/history/[instanceId]', params: { instanceId } })}
        onShowSessions={() => {
          if (controlPlaneId) mobileAiSessionStore.setScope(controlPlaneId, { kind: 'instance', instanceId });
          router.push({ pathname: '/(tabs)/(main)/inbox', params: { instanceId } });
        }}
        problemSessionCount={instance.aiSessions.problemCount}
        protocol={instance.protocol.version || t('instance.notReported')}
        protocolCompatible={instance.protocol.compatible}
        runtime={`${instance.runtime.name || instance.runtime.id}${instance.runtime.type ? ` · ${instance.runtime.type}` : ''}`}
        workspace={instance.workspace.path || instance.workspace.status}
      />

      {instance.protocol.warning ? <Notice text={instance.protocol.warning} /> : null}
      {instance.error ? <Notice error text={`${instance.error.code}: ${instance.error.message}`} /> : null}

    </Screen>
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

function Notice({ error, text }: { error?: boolean; text: string }) {
  const { colors } = useMobileTheme();
  return <View style={[styles.notice, { backgroundColor: error ? colors.errorSoft : colors.notice }]}>
    <SystemIcon android={error ? 'error' : 'warning'} color={error ? colors.error : colors.noticeText} ios={error ? 'xmark.circle.fill' : 'exclamationmark.triangle.fill'} size={17} />
    <Text style={[styles.noticeText, { color: error ? colors.error : colors.noticeText }]}>{text}</Text>
  </View>;
}

const styles = StyleSheet.create({
  emptyScreen: { flexGrow: 1, justifyContent: 'center' },
  statusSummary: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, minHeight: 42, paddingHorizontal: 12 },
  statusDot: { borderRadius: 999, height: 8, width: 8 },
  statusText: { fontSize: 13, textTransform: 'capitalize' },
  lifecycleToolbar: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 62, overflow: 'hidden' },
  lifecycleButton: { alignItems: 'center', flex: 1, gap: 4, justifyContent: 'center', minHeight: 62, minWidth: 0, paddingHorizontal: 4, paddingVertical: 8 },
  lifecycleButtonDisabled: { opacity: 0.42 },
  lifecycleButtonText: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  notice: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 9, padding: 12 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  error: { fontSize: 14, lineHeight: 20 },
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
