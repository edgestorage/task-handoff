import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { GripVertical } from 'lucide-react-native';
import { Alert, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canInterruptAiSession, isAiSessionApprovalPending, type ControlPlaneAiSessionSummary, type ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { AiSessionMentionCandidate, AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';

import { mobileAiSessionBusyKey, MobileAiSessionActionCoordinator, MobileAiSessionDraftStore } from './actions';
import { aiSessionDisplayTurns, SessionDetail, type SessionDetailMode } from './SessionDetail';
import type { MobileStreamingMessage } from './store';
import { pickDocument, pickImage } from '../platform/file-picker';
import { runtimeAttachmentFromServerCandidate, uploadMobileAttachment, usableUploadRefs, type MobilePendingAttachment } from './attachments';
import { useMobileTheme } from '../components/theme';
import { SystemIcon } from '../components/SystemIcon';
import { SessionComposer } from './SessionComposer';
import { useI18n, type Translate } from '../i18n';
import type { MobileAiSessionPermissionStore } from './permission-store';

export function SessionWorkspace({
  controlPlaneId,
  instanceId,
  session,
  messages,
  actions,
  drafts,
  permissions,
  defaultPermissionMode,
  client,
  onVisible,
  detailMode: controlledDetailMode,
  onDetailModeChange,
  syncPhase = 'ready',
}: {
  controlPlaneId: string;
  instanceId: string;
  session?: ControlPlaneAiSessionSummary;
  messages: readonly MobileStreamingMessage[];
  actions?: MobileAiSessionActionCoordinator;
  drafts?: MobileAiSessionDraftStore;
  permissions?: MobileAiSessionPermissionStore;
  defaultPermissionMode?: AiSessionPermissionMode;
  client?: ControlPlaneClient;
  onVisible?(updatedAt: string): void;
  detailMode?: SessionDetailMode;
  onDetailModeChange?(mode: SessionDetailMode): void;
  syncPhase?: 'idle' | 'loading' | 'ready' | 'stale' | 'offline' | 'error';
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const latestDraft = useRef('');
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [permissionSelection, setPermissionSelection] = useState<{
    key: string;
    mode: AiSessionPermissionMode;
    resolved: boolean;
  }>();
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const [, rerender] = useState(0);
  const [attachments, setAttachments] = useState<MobilePendingAttachment[]>([]);
  const [runtimeCandidates, setRuntimeCandidates] = useState<AiSessionMentionCandidate[]>([]);
  const [selectedTurnIndex, setSelectedTurnIndex] = useState(() => Math.max(0, aiSessionDisplayTurns(session).length - 1));
  const [localDetailMode, setLocalDetailMode] = useState<SessionDetailMode>('turn');
  const detailMode = controlledDetailMode ?? localDetailMode;
  const setDetailMode = (next: SessionDetailMode) => {
    if (controlledDetailMode === undefined) setLocalDetailMode(next);
    onDetailModeChange?.(next);
  };
  const selectionSessionId = useRef<string | undefined>(undefined);
  const knownTurnCount = useRef(0);
  const sessionId = session?.id;
  const permissionKey = sessionId ? `${controlPlaneId}\u0000${instanceId}\u0000${sessionId}` : undefined;
  const permissionMode = permissionSelection && permissionSelection.key === permissionKey
    ? permissionSelection.mode
    : defaultPermissionMode ?? 'ask';
  const turnCount = aiSessionDisplayTurns(session).length;
  const latestTurnIndex = Math.max(0, turnCount - 1);
  useEffect(() => actions?.subscribe(() => rerender((value) => value + 1)), [actions]);
  useEffect(() => {
    let live = true;
    latestDraft.current = '';
    setDraft('');
    if (sessionId && drafts) void drafts.read(controlPlaneId, instanceId, sessionId).then((text) => {
      if (live) { latestDraft.current = text; setDraft(text); }
    });
    return () => {
      live = false;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (sessionId && drafts) void drafts.write(controlPlaneId, instanceId, sessionId, latestDraft.current);
    };
  }, [controlPlaneId, drafts, instanceId, sessionId]);
  useEffect(() => {
    if (!sessionId || session?.agent !== 'codex' || !defaultPermissionMode) return;
    let live = true;
    const key = `${controlPlaneId}\u0000${instanceId}\u0000${sessionId}`;
    setPermissionSelection((current) => current?.key === key
      ? current
      : { key, mode: defaultPermissionMode, resolved: !permissions });
    if (permissions) void permissions.read(controlPlaneId, instanceId, sessionId, defaultPermissionMode).then((stored) => {
      if (live) setPermissionSelection((current) => current?.key === key && !current.resolved
        ? { key, mode: stored, resolved: true }
        : current);
    });
    return () => { live = false; };
  }, [controlPlaneId, defaultPermissionMode, instanceId, permissions, session?.agent, sessionId]);
  useEffect(() => {
    const sameSession = selectionSessionId.current === sessionId;
    const previousCount = knownTurnCount.current;
    setSelectedTurnIndex((current) => !sameSession || current >= previousCount - 1 ? latestTurnIndex : Math.min(current, latestTurnIndex));
    selectionSessionId.current = sessionId;
    knownTurnCount.current = turnCount;
  }, [latestTurnIndex, sessionId, turnCount]);
  if (!session) return <SessionDetail messages={messages} session={session} />;
  const authoritativeActionsEnabled = syncPhase === 'ready';
  const isLatestTurn = detailMode === 'conversation' || selectedTurnIndex >= latestTurnIndex;
  const canInterrupt = canInterruptAiSession(session);
  const approvalPending = isAiSessionApprovalPending(session);
  const state = (action: Parameters<typeof mobileAiSessionBusyKey>[3], queueId?: string) => actions?.state(mobileAiSessionBusyKey(controlPlaneId, instanceId, session.id, action, queueId));
  const sendState = state('send');
  const actionErrors = [sendState, state('interrupt'), ...(isLatestTurn ? [state('approval'), ...session.queue.items.flatMap((item) => [
    state('queue-steer', item.id), state('queue-retry', item.id), state('queue-remove', item.id),
  ])] : [])].map((candidate) => candidate?.error).filter((error, index, all): error is string => Boolean(error) && all.indexOf(error) === index);
  const send = async () => {
    if (!actions || !draft.trim()) return;
    let refs;
    try { refs = usableUploadRefs(attachments); }
    catch (cause) { setAttachments((current) => [...current, { localId: 'validation', kind: 'file', name: 'Attachment', mime: 'application/octet-stream', size: 0, phase: 'failed', error: cause instanceof Error ? cause.message : 'Attachment invalid.' }]); return; }
    const selectedPermissionMode = permissionSelection && permissionSelection.key === permissionKey && permissionSelection.resolved
      ? permissionSelection.mode
      : defaultPermissionMode;
    const result = await actions.send(instanceId, session.id, draft.trim(), session.agent === 'codex' ? selectedPermissionMode : undefined, refs, 'auto');
    if (result.disposition === 'accepted') {
      setDraft('');
      latestDraft.current = '';
      if (draftTimer.current) clearTimeout(draftTimer.current);
      setAttachments([]);
      await drafts?.write(controlPlaneId, instanceId, session.id, '');
    } else if (result.disposition === 'result-unknown') setAttachments([]);
  };
  const selectLocal = async (kind: 'image' | 'file') => {
    if (!client) return;
    try {
      const local = await (kind === 'image' ? pickImage() : pickDocument());
      if (!local) return;
      const uploaded = await uploadMobileAttachment(client, { instanceId, sessionId: session.id }, local);
      setAttachments((current) => [...current.filter((item) => item.localId !== uploaded.localId), uploaded]);
    } catch (cause) {
      setAttachments((current) => [...current, { localId: `failed:${Date.now()}`, kind, name: 'Attachment', mime: 'application/octet-stream', size: 0, phase: 'failed', error: cause instanceof Error ? cause.message : 'Could not select attachment.' }]);
    }
  };
  const loadRuntimeFiles = async () => {
    if (!client) return;
    try {
      const catalog = await client.aiSessions.mentionCatalog(instanceId, session.id);
      setRuntimeCandidates(catalog.candidates.filter((candidate) => candidate.kind === 'file').slice(0, 20));
    } catch { setRuntimeCandidates([]); }
  };
  const updateDraft = (text: string) => {
    setDraft(text);
    latestDraft.current = text;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (drafts) draftTimer.current = setTimeout(() => { void drafts.write(controlPlaneId, instanceId, session.id, text); }, 150);
  };
  const hasDraft = Boolean(draft.trim());
  const composerAction = !hasDraft && canInterrupt ? 'stop' : 'send';
  const composerDisabled = !authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes((composerAction === 'stop' ? state('interrupt') : sendState)?.phase || '')
    || (composerAction === 'stop' ? !canInterrupt : !session.actions?.send || !hasDraft);
  const runComposerAction = () => {
    if (composerAction === 'stop') void actions?.interrupt(instanceId, session.id);
    else void send();
  };
  const setComposerFocus = (focused: boolean) => {
    setComposerFocused(focused);
  };
  const updatePermissionMode = (mode: AiSessionPermissionMode) => {
    if (permissionKey) setPermissionSelection({ key: permissionKey, mode, resolved: true });
    if (sessionId && permissions) void permissions.write(controlPlaneId, instanceId, sessionId, mode).catch(() => undefined);
  };
  return (
    <KeyboardAvoidingView behavior={sessionKeyboardAvoidingBehavior(Platform.OS)} style={styles.fill} testID="session-workspace">
      <View onTouchStart={Keyboard.dismiss} style={styles.fill} testID="session-content">
        <SessionDetail bottomInset={composerOverlayHeight} messages={messages} mode={detailMode} onModeChange={setDetailMode} onVisible={onVisible} onTurnIndexChange={setSelectedTurnIndex} session={session} showModePicker={controlledDetailMode === undefined} turnIndex={selectedTurnIndex} />
      </View>
      <View onLayout={(event) => setComposerOverlayHeight(event.nativeEvent.layout.height)} style={[styles.actions, { paddingBottom: Math.max(insets.bottom, 8) }]} testID="session-actions">
        {!authoritativeActionsEnabled ? (
          <View style={[styles.notice, { backgroundColor: colors.notice }]}> 
            <SystemIcon android="cloud_off" color={colors.noticeText} ios="icloud.slash" size={16} />
            <Text accessibilityLiveRegion="polite" style={[styles.noticeText, { color: colors.noticeText }]}>{t('workspace.offline')}</Text>
          </View>
        ) : null}
        {isLatestTurn && approvalPending ? (
          <View style={[styles.approval, { backgroundColor: colors.notice }]}> 
            <View style={styles.approvalTitleRow}>
              <SystemIcon android="approval" color={colors.noticeText} ios="hand.raised.fill" size={17} />
              <Text style={[styles.approvalTitle, { color: colors.noticeText }]}>{t('sessions.approvalNeeded')}</Text>
            </View>
            <View style={styles.actionRow}>
              {(['allow', 'skip', 'deny'] as const).map((decision) => (
                <ApprovalButton key={decision} decision={decision} label={t(`workspace.${decision}` as 'workspace.allow')} disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('approval')?.phase || '')} onPress={() => {
                  const decisionLabel = t(`workspace.${decision}` as 'workspace.allow');
                  Alert.alert(t('workspace.resolveApproval'), t('workspace.sendDecision', { decision: decisionLabel }), [
                    { text: t('common.cancel'), style: 'cancel' },
                    { text: decisionLabel, onPress: () => { void actions?.approval(instanceId, session.id, decision); } },
                  ]);
                }} />
              ))}
            </View>
          </View>
        ) : null}
        {isLatestTurn && session.queue.items.length ? <View style={[styles.queueListFrame, { backgroundColor: colors.surface, borderColor: colors.border }]}><FlatList
          accessibilityLabel={t('workspace.queuedMessages')}
          data={session.queue.items}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          style={styles.queueList}
          ItemSeparatorComponent={() => <View style={[styles.queueSeparator, { backgroundColor: colors.border }]} />}
          renderItem={({ item }) => {
            const metadata = [
              item.status === 'failed' ? t('workspace.queueFailed') : undefined,
              item.permissionMode ? queuePermissionLabel(item.permissionMode, t) : undefined,
              item.attachments.length ? t('workspace.queueAttachments', { count: item.attachments.length }) : undefined,
              item.references.length ? t('workspace.queueReferences', { count: item.references.length }) : undefined,
            ].filter(Boolean).join(' · ');
            return (
              <View style={styles.queueRow}>
                <View style={styles.queueContent}>
                  <GripVertical color={item.status === 'failed' ? colors.error : colors.textMuted} size={17} strokeWidth={1.8} />
                  <View style={styles.queueCopy}>
                    <Text numberOfLines={2} style={[styles.queueText, { color: colors.text }]}>{item.message}</Text>
                    {metadata ? <Text numberOfLines={1} style={[styles.queueMeta, { color: colors.textMuted }]}>{metadata}</Text> : null}
                    {item.error ? <Text numberOfLines={2} style={[styles.error, styles.queueError, { color: colors.error }]}>{item.error}</Text> : null}
                  </View>
                </View>
                <View style={styles.queueActions}>
                  <QueueActionButton icon={{ android: 'turn_right', ios: 'arrow.turn.up.right' }} label={t('workspace.steerAction')} disabled={!authoritativeActionsEnabled || !actions || !canInterrupt || ['busy', 'result-unknown'].includes(state('queue-steer', item.id)?.phase || '')} onPress={() => { void actions?.queue(instanceId, session.id, item.id, 'steer'); }} showLabel />
                  {item.status === 'failed' ? <QueueActionButton icon={{ android: 'refresh', ios: 'arrow.clockwise' }} label={t('workspace.retryAction')} disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('queue-retry', item.id)?.phase || '')} onPress={() => { void actions?.queue(instanceId, session.id, item.id, 'retry'); }} /> : null}
                  <QueueActionButton destructive icon={{ android: 'close', ios: 'xmark' }} label={t('workspace.removeAction')} disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('queue-remove', item.id)?.phase || '')} onPress={() => { void actions?.queue(instanceId, session.id, item.id, 'remove'); }} />
                </View>
              </View>
            );
          }}
        /></View> : null}
        {runtimeCandidates.length ? <FlatList accessibilityLabel="Runtime files" data={runtimeCandidates} keyExtractor={(candidate) => candidate.path} keyboardShouldPersistTaps="handled" nestedScrollEnabled style={[styles.runtimeFiles, { backgroundColor: colors.background }]} contentContainerStyle={styles.runtimeFilesContent} renderItem={({ item: candidate }) => <Pressable accessibilityLabel={`${candidate.name}, ${candidate.path}`} accessibilityRole="button" onPress={() => {
          if (!session.cwd) return;
          try {
            const uploadRef = runtimeAttachmentFromServerCandidate(candidate, session.cwd);
            setAttachments((current) => [...current, { localId: uploadRef.id, kind: 'file', name: candidate.name, mime: 'application/octet-stream', size: 0, phase: 'uploaded', uploadRef }]);
            setRuntimeCandidates([]);
          } catch { setRuntimeCandidates([]); }
        }}><Text style={[styles.runtimeFile, { color: colors.primary }]}>{candidate.name} · {candidate.path}</Text></Pressable>} /> : null}
        {attachments.length ? <View style={styles.attachments}>{attachments.map((attachment) => <View key={attachment.localId} style={[styles.attachment, { backgroundColor: colors.surfaceMuted }]}><SystemIcon android={attachment.kind === 'image' ? 'image' : 'description'} color={colors.textMuted} ios={attachment.kind === 'image' ? 'photo' : 'doc'} size={15} /><Text numberOfLines={1} style={[styles.attachmentName, { color: colors.text }]}>{attachment.name}</Text><Text style={[styles.attachmentPhase, { color: attachment.phase === 'failed' ? colors.error : colors.textMuted }]}>{attachment.phase}</Text><Pressable accessibilityLabel={`Remove ${attachment.name}`} accessibilityRole="button" hitSlop={8} onPress={() => setAttachments((current) => current.filter((item) => item.localId !== attachment.localId))}><SystemIcon android="close" color={colors.textMuted} ios="xmark.circle.fill" size={17} /></Pressable>{attachment.error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{attachment.error}</Text> : null}</View>)}</View> : null}
        <SessionComposer
          action={composerAction}
          actionDisabled={composerDisabled}
          editable={authoritativeActionsEnabled}
          fileDisabled={!authoritativeActionsEnabled || !client}
          focused={composerFocused}
          imageDisabled={!authoritativeActionsEnabled || !client}
          onAction={runComposerAction}
          onAddFile={() => { void selectLocal('file'); }}
          onAddImage={() => { void selectLocal('image'); }}
          onAddRuntimeFile={() => { void loadRuntimeFiles(); }}
          onFocusChange={setComposerFocus}
          onPermissionModeChange={updatePermissionMode}
          onValueChange={updateDraft}
          permissionEnabled={session.agent === 'codex'}
          permissionMode={permissionMode}
          runtimeFileDisabled={!authoritativeActionsEnabled || !client || !session.cwd}
          value={draft}
        />
        {actionErrors.map((error) => <Text accessibilityLiveRegion="polite" key={error} style={[styles.error, { color: colors.error }]}>{error}</Text>)}
      </View>
    </KeyboardAvoidingView>
  );
}

export function sessionKeyboardAvoidingBehavior(platform: string): 'height' | undefined {
  return platform === 'ios' ? 'height' : undefined;
}

function ApprovalButton({ label, decision, disabled, onPress }: { label: string; decision: 'allow' | 'skip' | 'deny'; disabled?: boolean; onPress(): void }) {
  const { colors } = useMobileTheme();
  const color = decision === 'deny' ? colors.error : decision === 'allow' ? colors.primary : colors.textMuted;
  const icon = decision === 'allow'
    ? { android: 'check' as const, ios: 'checkmark' as const }
    : decision === 'skip'
      ? { android: 'block' as const, ios: 'nosign' as const }
      : { android: 'close' as const, ios: 'xmark' as const };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.approvalButton, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <SystemIcon android={icon.android} color={color} ios={icon.ios} size={14} />
      <Text style={[styles.approvalButtonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

function QueueActionButton({ label, icon, destructive = false, disabled, onPress, showLabel = false }: { label: string; icon: Pick<ComponentProps<typeof SystemIcon>, 'android' | 'ios'>; destructive?: boolean; disabled?: boolean; onPress(): void; showLabel?: boolean }) {
  const { colors } = useMobileTheme();
  const color = destructive ? colors.error : colors.primary;
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} hitSlop={5} onPress={onPress} style={({ pressed }) => [styles.queueAction, disabled && styles.disabled, pressed && styles.pressed]}><SystemIcon android={icon.android} color={color} ios={icon.ios} size={14} />{showLabel ? <Text style={[styles.queueActionText, { color }]}>{label}</Text> : null}</Pressable>;
}

function queuePermissionLabel(mode: AiSessionPermissionMode, t: Translate) {
  if (mode === 'auto-review') return t('composer.autoReview');
  if (mode === 'full-access') return t('composer.fullAccess');
  return t('composer.ask');
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  actions: { bottom: 0, gap: 8, left: 0, paddingHorizontal: 12, paddingTop: 8, position: 'absolute', right: 0, zIndex: 10 },
  actionRow: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  approval: { borderRadius: 14, gap: 8, padding: 10 },
  approvalTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 7, paddingHorizontal: 2 },
  approvalTitle: { fontSize: 14, fontWeight: '700', lineHeight: 19 },
  approvalButton: { alignItems: 'center', borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, flex: 1, flexDirection: 'row', gap: 5, justifyContent: 'center', minHeight: 38, paddingHorizontal: 8 },
  approvalButtonText: { fontSize: 13, fontWeight: '700', lineHeight: 18 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  queueListFrame: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  queueList: { maxHeight: 224 },
  queueSeparator: { height: StyleSheet.hairlineWidth, marginLeft: 40 },
  queueRow: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 52, paddingHorizontal: 10, paddingVertical: 8 },
  queueContent: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 9, minWidth: 0 },
  queueCopy: { flex: 1, gap: 1, minWidth: 0 },
  queueText: { fontSize: 14, fontWeight: '500', lineHeight: 20 },
  queueMeta: { fontSize: 12, lineHeight: 17 },
  queueError: { marginTop: 1 },
  queueActions: { alignItems: 'center', flexDirection: 'row', gap: 2 },
  queueAction: { alignItems: 'center', borderRadius: 8, flexDirection: 'row', gap: 4, height: 34, justifyContent: 'center', minWidth: 34, paddingHorizontal: 6 },
  queueActionText: { fontSize: 12, fontWeight: '700', lineHeight: 17 },
  notice: { alignItems: 'flex-start', borderRadius: 10, flexDirection: 'row', gap: 8, padding: 12 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  error: { color: '#b91c1c', fontSize: 13, lineHeight: 18 },
  attachments: { gap: 8 },
  attachment: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  attachmentName: { flex: 1, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  attachmentPhase: { fontSize: 12, lineHeight: 17, textTransform: 'capitalize' },
  runtimeFiles: { backgroundColor: '#f8fafc', borderRadius: 10, maxHeight: 128 }, runtimeFilesContent: { gap: 8, padding: 10 },
  runtimeFile: { color: '#2563eb', fontSize: 13, lineHeight: 18 },
});
