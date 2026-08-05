import { useEffect, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, LayoutAnimation, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
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
import { SessionComposerToolbar } from './NativeSessionControls';

export function SessionWorkspace({
  controlPlaneId,
  instanceId,
  session,
  messages,
  actions,
  drafts,
  client,
  onVisible,
  syncPhase = 'ready',
}: {
  controlPlaneId: string;
  instanceId: string;
  session?: ControlPlaneAiSessionSummary;
  messages: readonly MobileStreamingMessage[];
  actions?: MobileAiSessionActionCoordinator;
  drafts?: MobileAiSessionDraftStore;
  client?: ControlPlaneClient;
  onVisible?(updatedAt: string): void;
  syncPhase?: 'idle' | 'loading' | 'ready' | 'stale' | 'offline' | 'error';
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useMobileTheme();
  const [draft, setDraft] = useState('');
  const latestDraft = useRef('');
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [permissionMode, setPermissionMode] = useState<AiSessionPermissionMode>('ask');
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const [, rerender] = useState(0);
  const [attachments, setAttachments] = useState<MobilePendingAttachment[]>([]);
  const [runtimeCandidates, setRuntimeCandidates] = useState<AiSessionMentionCandidate[]>([]);
  const [selectedTurnIndex, setSelectedTurnIndex] = useState(() => Math.max(0, aiSessionDisplayTurns(session).length - 1));
  const [detailMode, setDetailMode] = useState<SessionDetailMode>('turn');
  const selectionSessionId = useRef<string | undefined>(undefined);
  const knownTurnCount = useRef(0);
  const sessionId = session?.id;
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
  const send = async (mode: 'auto' | 'steer' = 'auto') => {
    if (!actions || !draft.trim()) return;
    let refs;
    try { refs = usableUploadRefs(attachments); }
    catch (cause) { setAttachments((current) => [...current, { localId: 'validation', kind: 'file', name: 'Attachment', mime: 'application/octet-stream', size: 0, phase: 'failed', error: cause instanceof Error ? cause.message : 'Attachment invalid.' }]); return; }
    const result = await actions.send(instanceId, session.id, draft.trim(), permissionMode, refs, mode);
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
  const composerAction = !hasDraft && canInterrupt ? 'stop' : hasDraft && session.status === 'running' && canInterrupt ? 'steer' : 'send';
  const composerDisabled = !authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes((composerAction === 'stop' ? state('interrupt') : sendState)?.phase || '')
    || (composerAction === 'stop' ? !canInterrupt : !session.actions?.send || !hasDraft);
  const runComposerAction = () => {
    if (composerAction === 'stop') void actions?.interrupt(instanceId, session.id);
    else void send(composerAction === 'steer' ? 'steer' : 'auto');
  };
  const setComposerFocus = (focused: boolean) => {
    if (Platform.OS === 'ios') LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setComposerFocused(focused);
  };
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
      <SessionDetail bottomInset={composerOverlayHeight} messages={messages} mode={detailMode} onModeChange={setDetailMode} onVisible={onVisible} onTurnIndexChange={setSelectedTurnIndex} session={session} turnIndex={selectedTurnIndex} />
      <View onLayout={(event) => setComposerOverlayHeight(event.nativeEvent.layout.height)} style={[styles.actions, { paddingBottom: Math.max(insets.bottom, 8) }]}> 
        {!authoritativeActionsEnabled ? (
          <View style={[styles.notice, { backgroundColor: colors.notice }]}> 
            <SystemIcon android="cloud_off" color={colors.noticeText} ios="icloud.slash" size={16} />
            <Text accessibilityLiveRegion="polite" style={[styles.noticeText, { color: colors.noticeText }]}>Live state is unavailable. Actions are disabled until the Control Plane snapshot recovers.</Text>
          </View>
        ) : null}
        {isLatestTurn && approvalPending ? (
          <View style={[styles.approval, { backgroundColor: colors.notice }]}> 
            <View style={styles.approvalTitleRow}>
              <SystemIcon android="approval" color={colors.noticeText} ios="hand.raised.fill" size={17} />
              <Text style={[styles.approvalTitle, { color: colors.noticeText }]}>Approval needed</Text>
            </View>
            <View style={styles.actionRow}>
            {(['allow', 'deny', 'skip'] as const).map((decision) => (
              <ActionButton key={decision} label={decision} tone={decision === 'deny' ? 'danger' : 'secondary'} disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('approval')?.phase || '')} onPress={() => {
                Alert.alert('Resolve approval?', `Send “${decision}” to this session?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: decision, onPress: () => { void actions?.approval(instanceId, session.id, decision); } },
                ]);
              }} />
            ))}
            </View>
          </View>
        ) : null}
        {isLatestTurn && session.queue.items.length ? <FlatList
          accessibilityLabel="Queued messages"
          data={session.queue.items}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          style={styles.queueList}
          contentContainerStyle={styles.queueListContent}
          renderItem={({ item }) => (
            <View style={[styles.queue, { backgroundColor: colors.surfaceMuted }]}> 
              <View style={styles.queueHeading}>
                <SystemIcon android="schedule" color={colors.textMuted} ios="clock" size={14} />
                <Text style={[styles.queueLabel, { color: colors.textMuted }]}>Queued</Text>
              </View>
              <Text numberOfLines={2} style={[styles.queueText, { color: colors.text }]}>{item.message}</Text>
              <Text style={[styles.queueMeta, { color: colors.textMuted }]}>{item.status}{item.permissionMode ? ` · ${item.permissionMode}` : ''} · {item.attachments.length} attachments · {item.references.length} references</Text>
              {item.error ? <Text style={[styles.error, { color: colors.error }]}>{item.error}</Text> : null}
              <View style={styles.actionRow}>
                <ActionButton label="steer" tone="secondary" disabled={!authoritativeActionsEnabled || !actions || !canInterrupt || ['busy', 'result-unknown'].includes(state('queue-steer', item.id)?.phase || '')} onPress={() => { void actions?.queue(instanceId, session.id, item.id, 'steer'); }} />
                {item.status === 'failed' ? <ActionButton label="retry" tone="secondary" disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('queue-retry', item.id)?.phase || '')} onPress={() => { void actions?.queue(instanceId, session.id, item.id, 'retry'); }} /> : null}
                <ActionButton label="remove" tone="danger" disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('queue-remove', item.id)?.phase || '')} onPress={() => { void actions?.queue(instanceId, session.id, item.id, 'remove'); }} />
              </View>
            </View>
          )}
        /> : null}
        {runtimeCandidates.length ? <FlatList accessibilityLabel="Runtime files" data={runtimeCandidates} keyExtractor={(candidate) => candidate.path} keyboardShouldPersistTaps="handled" nestedScrollEnabled style={[styles.runtimeFiles, { backgroundColor: colors.background }]} contentContainerStyle={styles.runtimeFilesContent} renderItem={({ item: candidate }) => <Pressable accessibilityLabel={`${candidate.name}, ${candidate.path}`} accessibilityRole="button" onPress={() => {
          if (!session.cwd) return;
          try {
            const uploadRef = runtimeAttachmentFromServerCandidate(candidate, session.cwd);
            setAttachments((current) => [...current, { localId: uploadRef.id, kind: 'file', name: candidate.name, mime: 'application/octet-stream', size: 0, phase: 'uploaded', uploadRef }]);
            setRuntimeCandidates([]);
          } catch { setRuntimeCandidates([]); }
        }}><Text style={[styles.runtimeFile, { color: colors.primary }]}>{candidate.name} · {candidate.path}</Text></Pressable>} /> : null}
        {attachments.length ? <View style={styles.attachments}>{attachments.map((attachment) => <View key={attachment.localId} style={[styles.attachment, { backgroundColor: colors.surfaceMuted }]}><SystemIcon android={attachment.kind === 'image' ? 'image' : 'description'} color={colors.textMuted} ios={attachment.kind === 'image' ? 'photo' : 'doc'} size={15} /><Text numberOfLines={1} style={[styles.attachmentName, { color: colors.text }]}>{attachment.name}</Text><Text style={[styles.attachmentPhase, { color: attachment.phase === 'failed' ? colors.error : colors.textMuted }]}>{attachment.phase}</Text><Pressable accessibilityLabel={`Remove ${attachment.name}`} accessibilityRole="button" hitSlop={8} onPress={() => setAttachments((current) => current.filter((item) => item.localId !== attachment.localId))}><SystemIcon android="close" color={colors.textMuted} ios="xmark.circle.fill" size={17} /></Pressable>{attachment.error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{attachment.error}</Text> : null}</View>)}</View> : null}
        <View style={[styles.composerRow, composerFocused && styles.composerRowFocused, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}> 
          <View style={styles.nativeToolbar}>
            <SessionComposerToolbar
              fileDisabled={!authoritativeActionsEnabled || !client}
              imageDisabled={!authoritativeActionsEnabled || !client}
              onAddFile={() => { void selectLocal('file'); }}
              onAddImage={() => { void selectLocal('image'); }}
              onAddRuntimeFile={() => { void loadRuntimeFiles(); }}
              onInterrupt={() => undefined}
              onPermissionModeChange={setPermissionMode}
              permissionMode={permissionMode}
              runtimeFileDisabled={!authoritativeActionsEnabled || !client || !session.cwd}
              showInterrupt={false}
            />
          </View>
          <TextInput
            accessibilityLabel="Message"
            editable={authoritativeActionsEnabled}
            multiline
            onBlur={() => setComposerFocus(false)}
            onChangeText={updateDraft}
            onFocus={() => setComposerFocus(true)}
            placeholder="Message this session"
            placeholderTextColor={colors.textMuted}
            style={[styles.input, composerFocused && styles.inputFocused, { color: colors.text }]}
            textAlignVertical="top"
            value={draft}
          />
          <Pressable accessibilityLabel={composerAction === 'stop' ? 'Stop' : composerAction === 'steer' ? 'Steer' : 'Send'} accessibilityRole="button" accessibilityState={{ disabled: composerDisabled }} disabled={composerDisabled} onPress={runComposerAction} style={({ pressed }) => [styles.sendButton, { backgroundColor: composerAction === 'stop' ? colors.error : colors.primaryButton }, pressed && styles.pressed, composerDisabled && styles.disabled]}>
            <SystemIcon android={composerAction === 'stop' ? 'stop' : composerAction === 'steer' ? 'turn_right' : 'arrow_upward'} color="#ffffff" ios={composerAction === 'stop' ? 'stop.fill' : composerAction === 'steer' ? 'arrow.turn.up.right' : 'arrow.up'} size={18} />
          </Pressable>
        </View>
        {actionErrors.map((error) => <Text accessibilityLiveRegion="polite" key={error} style={[styles.error, { color: colors.error }]}>{error}</Text>)}
      </View>
    </KeyboardAvoidingView>
  );
}

function ActionButton({ label, disabled, onPress, tone = 'primary' }: { label: string; disabled?: boolean; onPress(): void; tone?: 'primary' | 'secondary' | 'danger' }) {
  const { colors } = useMobileTheme();
  const backgroundColor = tone === 'primary' ? colors.primaryButton : tone === 'danger' ? colors.errorSoft : colors.surface;
  const color = tone === 'primary' ? '#ffffff' : tone === 'danger' ? colors.error : colors.primary;
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor, borderColor: tone === 'secondary' ? colors.border : backgroundColor }, tone === 'secondary' && styles.buttonBorder, disabled && styles.disabled, pressed && styles.pressed]}><Text style={[styles.buttonText, { color }]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  actions: { bottom: 0, gap: 7, left: 0, paddingHorizontal: 10, paddingTop: 6, position: 'absolute', right: 0, zIndex: 10 },
  actionRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  approval: { borderRadius: 12, gap: 8, padding: 10 },
  approvalTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  approvalTitle: { fontSize: 13, fontWeight: '700' },
  nativeToolbar: { alignSelf: 'flex-end', justifyContent: 'flex-end', marginLeft: -6, width: 104 },
  composerRow: {
    alignItems: 'center',
    borderRadius: 25,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 0,
    minHeight: 50,
    padding: 4,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.13,
    shadowRadius: 14,
  },
  composerRowFocused: { alignItems: 'flex-end', borderRadius: 24, minHeight: 104 },
  input: { alignSelf: 'stretch', flex: 1, fontSize: 16, lineHeight: 21, maxHeight: 128, minHeight: 40, paddingHorizontal: 4, paddingVertical: 9 },
  inputFocused: { minHeight: 94, paddingTop: 12 },
  sendButton: { alignItems: 'center', alignSelf: 'flex-end', borderRadius: 19, height: 38, justifyContent: 'center', width: 38 },
  button: { borderRadius: 9, minHeight: 36, justifyContent: 'center', paddingHorizontal: 12 },
  buttonBorder: { borderWidth: StyleSheet.hairlineWidth },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  buttonText: { fontSize: 12, fontWeight: '700', textTransform: 'capitalize' },
  queue: { backgroundColor: '#f1f5f9', borderRadius: 9, gap: 6, padding: 8 },
  queueHeading: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  queueLabel: { fontSize: 12, fontWeight: '700' },
  queueList: { maxHeight: 168 }, queueListContent: { gap: 7 },
  queueText: { color: '#334155', fontSize: 12 },
  queueMeta: { color: '#64748b', fontSize: 12 },
  notice: { alignItems: 'flex-start', borderRadius: 10, flexDirection: 'row', gap: 7, padding: 9 },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 17 },
  error: { color: '#b91c1c', fontSize: 12, lineHeight: 17 },
  attachments: { gap: 5 },
  attachment: { alignItems: 'center', borderRadius: 9, flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingHorizontal: 9, paddingVertical: 7 },
  attachmentName: { flex: 1, fontSize: 12, fontWeight: '600' },
  attachmentPhase: { fontSize: 12, textTransform: 'capitalize' },
  runtimeFiles: { backgroundColor: '#f8fafc', borderRadius: 8, maxHeight: 120 }, runtimeFilesContent: { gap: 7, padding: 8 },
  runtimeFile: { color: '#2563eb', fontSize: 12 },
});
