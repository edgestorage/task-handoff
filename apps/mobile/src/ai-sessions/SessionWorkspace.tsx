import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { File } from 'expo-file-system';
import { CornerDownRight, GripVertical, Pencil, RotateCcw, Trash2, type LucideIcon } from 'lucide-react-native';
import { Alert, Animated, FlatList, Keyboard, KeyboardAvoidingView, PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { aiSessionMessageText, canInterruptAiSession, isAiSessionApprovalPending, type ControlPlaneAiSessionSummary, type ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { AiSessionMentionCandidate, AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';
import { supportsDirectoryAiSessionTimelineCapability, type ControlPlaneInstanceDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { mobileAiSessionBusyKey, MobileAiSessionActionCoordinator, MobileAiSessionDraftStore, type MobileActionResult } from './actions';
import { aiSessionDisplayTurns, SessionDetail, type SessionDetailMode } from './SessionDetail';
import { mobileAiSessionStore, type MobileStreamingMessage, type MobileTurnTimelineState } from './store';
import { pickDocument, pickImage } from '../platform/file-picker';
import { formatMobileAttachmentBytes, formatMobileTextLength, mobilePastedImage, mobilePastedText, runtimeAttachmentFromServerCandidate, uploadMobileAttachment, usableUploadRefs, type MobilePendingAttachment } from './attachments';
import { useMobileTheme } from '../components/theme';
import { SystemIcon } from '../components/SystemIcon';
import { SessionComposer } from './SessionComposer';
import { SESSION_COMPOSER_COLLAPSED_HEIGHT, SESSION_COMPOSER_EXPANDED_HEIGHT } from './composer-metrics';
import { useI18n, type Translate } from '../i18n';
import type { MobileAiSessionPermissionStore } from './permission-store';
import { useMobileToast } from '../components/MobileToast';
import { mobileWebMetric, mobileWebType } from '../components/mobile-web-typography';

export function SessionWorkspace({
  controlPlaneId,
  instanceId,
  session,
  messages,
  timelines = {},
  instanceCapabilities,
  actions,
  drafts,
  permissions,
  defaultPermissionMode,
  client,
  onVisible,
  onOpenSession,
  detailMode: controlledDetailMode,
  onDetailModeChange,
  syncPhase = 'ready',
}: {
  controlPlaneId: string;
  instanceId: string;
  session?: ControlPlaneAiSessionSummary;
  messages: readonly MobileStreamingMessage[];
  timelines?: Readonly<Record<string, MobileTurnTimelineState>>;
  instanceCapabilities?: ControlPlaneInstanceDirectoryEntry['capabilities'];
  actions?: MobileAiSessionActionCoordinator;
  drafts?: MobileAiSessionDraftStore;
  permissions?: MobileAiSessionPermissionStore;
  defaultPermissionMode?: AiSessionPermissionMode;
  client?: ControlPlaneClient;
  onVisible?(updatedAt: string): void;
  onOpenSession?(sessionId: string): void;
  detailMode?: SessionDetailMode;
  onDetailModeChange?(mode: SessionDetailMode): void;
  syncPhase?: 'idle' | 'loading' | 'ready' | 'stale' | 'offline' | 'error';
}) {
  const insets = useSafeAreaInsets();
  const composerBottomInset = Math.max(insets.bottom, 8);
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const toast = useMobileToast();
  const [draft, setDraft] = useState('');
  const latestDraft = useRef('');
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [permissionSelection, setPermissionSelection] = useState<{
    key: string;
    mode: AiSessionPermissionMode;
    resolved: boolean;
  }>();
  const [composerFocused, setComposerFocused] = useState(false);
  const [keyboardViewportRevision, setKeyboardViewportRevision] = useState(0);
  const [composerExpansion] = useState(() => new Animated.Value(0));
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(
    () => SESSION_COMPOSER_COLLAPSED_HEIGHT + 16 + composerBottomInset,
  );
  const [, rerender] = useState(0);
  const [attachments, setAttachments] = useState<MobilePendingAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  const pastedTextSequence = useRef(0);
  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (!attachment.retryLocal?.temporary) continue;
      try { new File(attachment.retryLocal.uri).delete(); } catch { /* Temporary paste cache may already be gone. */ }
    }
  }, []);
  const [runtimeCandidates, setRuntimeCandidates] = useState<AiSessionMentionCandidate[]>([]);
  const [queueEdit, setQueueEdit] = useState<{
    sessionId: string;
    queueId: string;
    originalMessage: string;
    previousDraft: string;
    previousAttachments: MobilePendingAttachment[];
    previousRuntimeCandidates: AiSessionMentionCandidate[];
  }>();
  const queueEditRef = useRef(queueEdit);
  queueEditRef.current = queueEdit;
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [queueOrderPreview, setQueueOrderPreview] = useState<string[]>();
  const [draggingQueueId, setDraggingQueueId] = useState<string>();
  const [queueDragOffsetY, setQueueDragOffsetY] = useState(0);
  const queueOrderPreviewRef = useRef<string[] | undefined>(undefined);
  const queueRowHeights = useRef(new Map<string, number>());
  const queueDrag = useRef<{ queueId: string; sourceCenter: number; sourceIds: string[]; targets: { index: number; center: number }[] } | undefined>(undefined);
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
  const currentSessionId = useRef(sessionId);
  currentSessionId.current = sessionId;
  const activeQueueEdit = queueEdit?.sessionId === sessionId ? queueEdit : undefined;
  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardViewportRevision((revision) => revision + 1);
    });
    return () => subscription?.remove?.();
  }, []);
  const permissionKey = sessionId ? `${controlPlaneId}\u0000${instanceId}\u0000${sessionId}` : undefined;
  const permissionMode = permissionSelection && permissionSelection.key === permissionKey
    ? permissionSelection.mode
    : defaultPermissionMode ?? 'ask';
  const turnCount = aiSessionDisplayTurns(session).length;
  const latestTurnIndex = Math.max(0, turnCount - 1);
  const timelineTurnSignature = (session?.turns ?? []).map((turn) => `${turn.id}:${turn.providerTurnId || ''}:${turn.status}`).join('|');
  const supportsTurnTimeline = session ? supportsDirectoryAiSessionTimelineCapability(instanceCapabilities, session.agent, 'turn-read') : false;
  const supportsSessionTimeline = session ? supportsDirectoryAiSessionTimelineCapability(instanceCapabilities, session.agent, 'session-read') : false;
  const supportsLiveTimeline = session ? supportsDirectoryAiSessionTimelineCapability(instanceCapabilities, session.agent, 'live-items') : false;
  const timelineRecoveryRevision = mobileAiSessionStore.timelineRecoveryRevision(controlPlaneId);
  const timelineLoadInputs = useRef({ session, timelines });
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
  useEffect(() => {
    timelineLoadInputs.current = { session, timelines };
  }, [session, timelines]);
  useEffect(() => {
    const timelineSession = timelineLoadInputs.current.session;
    const timelineStates = timelineLoadInputs.current.timelines;
    if (!client || !timelineSession || (!supportsTurnTimeline && !supportsSessionTimeline)) return;
    const turns = aiSessionDisplayTurns(timelineSession);
    const visibleTurns = detailMode === 'conversation' ? turns : turns.slice(selectedTurnIndex, selectedTurnIndex + 1);
    const loadableTurns = visibleTurns.filter((turn) => {
      const state = timelineStates[turn.id];
      if (state?.status && !['idle', 'stale'].includes(state.status)) return false;
      return true;
    });
    if (!loadableTurns.length) return;
    let active = true;
    if (supportsTurnTimeline) {
      for (const turn of loadableTurns) {
        mobileAiSessionStore.beginTurnTimeline(controlPlaneId, instanceId, timelineSession.id, turn);
        void client.aiSessions.turnTimeline(instanceId, timelineSession.id, turn.id).then((timeline) => {
          if (active) mobileAiSessionStore.resolveTurnTimeline(controlPlaneId, instanceId, timelineSession.id, turn, timeline.items);
        }).catch((cause) => {
          if (active) mobileAiSessionStore.rejectTurnTimeline(controlPlaneId, instanceId, timelineSession.id, turn, cause instanceof Error ? cause.message : 'Could not load the turn timeline.');
        });
      }
    } else {
      for (const turn of turns) mobileAiSessionStore.beginTurnTimeline(controlPlaneId, instanceId, timelineSession.id, turn);
      void client.aiSessions.timeline(instanceId, timelineSession.id).then((timeline) => {
        if (!active) return;
        for (const turn of turns) {
          const identities = new Set([turn.id, turn.providerTurnId].filter(Boolean));
          mobileAiSessionStore.resolveTurnTimeline(controlPlaneId, instanceId, timelineSession.id, turn, timeline.items.filter((item) => identities.has(item.turnId)));
        }
      }).catch((cause) => {
        if (!active) return;
        for (const turn of turns) mobileAiSessionStore.rejectTurnTimeline(controlPlaneId, instanceId, timelineSession.id, turn, cause instanceof Error ? cause.message : 'Could not load the session timeline.');
      });
    }
    return () => { active = false; };
    // Timeline store transitions deliberately do not restart in-flight reads.
  }, [client, controlPlaneId, detailMode, instanceId, selectedTurnIndex, session?.id, supportsSessionTimeline, supportsTurnTimeline, timelineRecoveryRevision, timelineTurnSignature]);
  useEffect(() => {
    queueOrderPreviewRef.current = undefined;
    setQueueOrderPreview(undefined);
    setDraggingQueueId(undefined);
    setQueueDragOffsetY(0);
    queueDrag.current = undefined;
  }, [session?.queue.revision, sessionId]);
  if (!session) return <SessionDetail messages={messages} session={session} />;
  const authoritativeActionsEnabled = syncPhase === 'ready';
  const isLatestTurn = detailMode === 'conversation' || selectedTurnIndex >= latestTurnIndex;
  const canInterrupt = canInterruptAiSession(session);
  const approvalPending = isAiSessionApprovalPending(session);
  const state = (action: Parameters<typeof mobileAiSessionBusyKey>[3], queueId?: string) => actions?.state(mobileAiSessionBusyKey(controlPlaneId, instanceId, session.id, action, queueId));
  const sendState = state('send');
  const performAction = async <T,>(label: string, operation: () => Promise<MobileActionResult<T>>) => {
    const result = await operation();
    if (result.disposition === 'failed' || result.disposition === 'result-unknown') {
      toast.show({ detail: result.error, title: t('toast.actionFailed', { action: label }), tone: 'error' });
    }
    return result;
  };
  const continueFromTurn = async (turn: { id: string }) => {
    if (!actions || !authoritativeActionsEnabled) return;
    const result = await performAction(t('sessions.continueFromTurn'), () => actions.fork(instanceId, session.id, turn.id, crypto.randomUUID()));
    if (result.disposition === 'accepted') onOpenSession?.(result.result.aiSessionId);
  };
  const queuedItems = session.queue.items.filter((item) => item.status === 'queued');
  const displayedQueueItems = queueItemsWithQueuedOrder(session.queue.items, queueOrderPreview);
  const commitQueueOrder = async (queueIds: string[]) => {
    if (!actions || arraysEqual(queueIds, queuedItems.map((item) => item.id))) return;
    const result = await performAction(t('workspace.reorderAction'), () => actions.reorderQueue(instanceId, session.id, session.queue.revision, queueIds));
    if (result.disposition !== 'accepted') {
      queueOrderPreviewRef.current = undefined;
      setQueueOrderPreview(undefined);
    }
  };
  const moveQueuedMessage = (queueId: string, offset: -1 | 1) => {
    const queueIds = queuedItems.map((item) => item.id);
    const index = queueIds.indexOf(queueId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= queueIds.length) return;
    const reordered = moveQueueId(queueIds, index, target);
    queueOrderPreviewRef.current = reordered;
    setQueueOrderPreview(reordered);
    void commitQueueOrder(reordered);
  };
  const beginQueueDrag = (queueId: string) => {
    const sourceIds = queuedItems.map((item) => item.id);
    let cursor = 0;
    const targets = sourceIds.flatMap((id, index) => {
      const height = queueRowHeights.current.get(id);
      if (!height) return [];
      const target = { index, center: cursor + height / 2 };
      cursor += height + StyleSheet.hairlineWidth;
      return [target];
    });
    const source = targets.find((target) => sourceIds[target.index] === queueId);
    if (!source || targets.length < 2) return;
    queueDrag.current = { queueId, sourceCenter: source.center, sourceIds, targets };
    queueOrderPreviewRef.current = sourceIds;
    setQueueOrderPreview(sourceIds);
    setDraggingQueueId(queueId);
    setQueueDragOffsetY(0);
  };
  const updateQueueDrag = (queueId: string, dy: number) => {
    const drag = queueDrag.current;
    if (!drag || drag.queueId !== queueId) return;
    const preview = queueDragPreview(drag.sourceIds, queueId, drag.sourceCenter, drag.targets, dy);
    setQueueDragOffsetY(preview.offsetY);
    if (!arraysEqual(preview.queueIds, queueOrderPreviewRef.current)) {
      queueOrderPreviewRef.current = preview.queueIds;
      setQueueOrderPreview(preview.queueIds);
    }
  };
  const finishQueueDrag = (queueId: string) => {
    const drag = queueDrag.current;
    if (!drag || drag.queueId !== queueId) return;
    const reordered = queueOrderPreviewRef.current || drag.sourceIds;
    queueDrag.current = undefined;
    setDraggingQueueId(undefined);
    setQueueDragOffsetY(0);
    if (arraysEqual(reordered, drag.sourceIds)) {
      queueOrderPreviewRef.current = undefined;
      setQueueOrderPreview(undefined);
      return;
    }
    void commitQueueOrder(reordered);
  };
  const cancelQueueDrag = (queueId: string) => {
    if (queueDrag.current?.queueId !== queueId) return;
    queueDrag.current = undefined;
    queueOrderPreviewRef.current = undefined;
    setQueueOrderPreview(undefined);
    setDraggingQueueId(undefined);
    setQueueDragOffsetY(0);
  };
  const restoreDraftAfterQueueEdit = (edit: NonNullable<typeof activeQueueEdit>) => {
    if (queueEditRef.current !== edit) return;
    if (edit.sessionId !== currentSessionId.current) {
      setQueueEdit((current) => current === edit ? undefined : current);
      return;
    }
    setQueueEdit(undefined);
    setDraft(edit.previousDraft);
    latestDraft.current = edit.previousDraft;
    setAttachments(edit.previousAttachments);
    setRuntimeCandidates(edit.previousRuntimeCandidates);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    void drafts?.write(controlPlaneId, instanceId, session.id, edit.previousDraft);
  };
  const beginQueueEdit = (queueId: string, message: string) => {
    const previous = activeQueueEdit;
    setQueueEdit({
      sessionId: session.id,
      queueId,
      originalMessage: message,
      previousDraft: previous?.previousDraft ?? draft,
      previousAttachments: previous?.previousAttachments ?? attachments,
      previousRuntimeCandidates: previous?.previousRuntimeCandidates ?? runtimeCandidates,
    });
    setDraft(message);
    setAttachments([]);
    setRuntimeCandidates([]);
    setComposerFocused(true);
    setComposerFocusRequest((value) => value + 1);
  };
  const saveQueueEdit = async () => {
    if (!actions || !activeQueueEdit || !draft.trim()) return;
    if (draft.trim() === activeQueueEdit.originalMessage.trim()) {
      restoreDraftAfterQueueEdit(activeQueueEdit);
      return;
    }
    const result = await performAction(t('workspace.saveAction'), () => actions.editQueue(instanceId, session.id, activeQueueEdit.queueId, session.queue.revision, draft.trim()));
    if (result.disposition === 'accepted') restoreDraftAfterQueueEdit(activeQueueEdit);
  };
  const send = async () => {
    if (!actions || (!draft.trim() && !attachments.length)) return;
    let refs;
    try { refs = usableUploadRefs(attachments); }
    catch (cause) { setAttachments((current) => [...current, { localId: 'validation', kind: 'file', name: 'Attachment', mime: 'application/octet-stream', size: 0, phase: 'failed', error: cause instanceof Error ? cause.message : 'Attachment invalid.' }]); return; }
    const selectedPermissionMode = permissionSelection && permissionSelection.key === permissionKey && permissionSelection.resolved
      ? permissionSelection.mode
      : defaultPermissionMode;
    const result = await performAction(t('composer.send'), () => actions.send(instanceId, session.id, aiSessionMessageText(draft.trim()), session.agent === 'codex' ? selectedPermissionMode : undefined, refs, 'auto'));
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
  const pasteImages = async (uris: string[]) => {
    if (!client) return;
    const pasted = await Promise.all(uris.map(async (uri, index): Promise<MobilePendingAttachment> => {
      try {
        return await uploadMobileAttachment(client, { instanceId, sessionId: session.id }, mobilePastedImage(uri));
      } catch (cause) {
        try { new File(uri).delete(); } catch { /* The native wrapper owns only temporary paste files. */ }
        return {
          error: cause instanceof Error ? cause.message : 'Could not paste image.',
          kind: 'image',
          localId: `clipboard-failed:${Date.now()}:${index}`,
          mime: 'application/octet-stream',
          name: 'Clipboard image',
          phase: 'failed',
          size: 0,
        };
      }
    }));
    setAttachments((current) => [...current.filter((item) => !pasted.some((next) => next.localId === item.localId)), ...pasted]);
  };
  const pasteText = async (text: string) => {
    if (!client || activeQueueEdit) return;
    try {
      if (attachments.length >= 6) throw new Error('You can attach at most 6 files.');
      const nextSequence = pastedTextSequence.current + 1;
      const local = mobilePastedText(text, nextSequence);
      pastedTextSequence.current = nextSequence;
      const uploaded = await uploadMobileAttachment(client, { instanceId, sessionId: session.id }, local);
      setAttachments((current) => [...current.filter((item) => item.localId !== uploaded.localId), uploaded]);
    } catch (cause) {
      toast.show({ detail: cause instanceof Error ? cause.message : 'Could not attach pasted text.', title: t('composer.addAttachment'), tone: 'error' });
    }
  };
  const retryAttachment = async (attachment: MobilePendingAttachment) => {
    if (!client || !attachment.retryLocal) return;
    const uploaded = await uploadMobileAttachment(client, { instanceId, sessionId: session.id }, attachment.retryLocal);
    setAttachments((current) => current.map((item) => item.localId === attachment.localId ? uploaded : item));
  };
  const removeAttachment = (attachment: MobilePendingAttachment) => {
    if (attachment.retryLocal?.temporary) {
      try { new File(attachment.retryLocal.uri).delete(); } catch { /* Temporary paste cache may already be gone. */ }
    }
    setAttachments((current) => current.filter((item) => item.localId !== attachment.localId));
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
    if (activeQueueEdit) return;
    latestDraft.current = text;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (drafts) draftTimer.current = setTimeout(() => { void drafts.write(controlPlaneId, instanceId, session.id, text); }, 150);
  };
  const hasDraft = Boolean(draft.trim() || attachments.length);
  const composerAction = activeQueueEdit ? 'save' : !hasDraft && canInterrupt ? 'stop' : 'send';
  const composerOperationState = composerAction === 'stop' ? state('interrupt') : composerAction === 'save' ? state('queue-edit', activeQueueEdit?.queueId) : sendState;
  const composerBusy = composerOperationState?.phase === 'busy';
  const composerDisabled = !authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(composerOperationState?.phase || '')
    || (composerAction === 'stop' ? !canInterrupt : composerAction === 'save'
      ? !hasDraft || draft.trim() === activeQueueEdit?.originalMessage.trim()
      : !session.actions?.send || !hasDraft);
  const runComposerAction = () => {
    if (composerAction === 'stop' && actions) void performAction(t('composer.stop'), () => actions.interrupt(instanceId, session.id));
    else if (composerAction === 'save') void saveQueueEdit();
    else void send();
  };
  const setComposerFocus = (focused: boolean) => {
    if (!focused && activeQueueEdit) restoreDraftAfterQueueEdit(activeQueueEdit);
    setComposerFocused(focused);
  };
  const updatePermissionMode = (mode: AiSessionPermissionMode) => {
    if (permissionKey) setPermissionSelection({ key: permissionKey, mode, resolved: true });
    if (sessionId && permissions) void permissions.write(controlPlaneId, instanceId, sessionId, mode).catch(() => undefined);
  };
  const composerBackdropHeight = composerExpansion.interpolate({
    inputRange: [0, 1],
    outputRange: [SESSION_COMPOSER_COLLAPSED_HEIGHT, SESSION_COMPOSER_EXPANDED_HEIGHT],
  });
  const composerFadeBottom = Animated.add(composerBackdropHeight, composerBottomInset);
  const bottomBackdrop = composerBottomBackdropGeometry(composerBottomInset);
  return (
    <View style={[styles.fill, { backgroundColor: colors.surface }]} testID="session-workspace-background">
      <KeyboardAvoidingView behavior={sessionKeyboardAvoidingBehavior(Platform.OS)} style={[styles.fill, { backgroundColor: colors.surface }]} testID="session-workspace">
      <View onTouchStart={Keyboard.dismiss} style={[styles.fill, { backgroundColor: colors.surface }]} testID="session-content">
        <SessionDetail
          bottomInset={composerOverlayHeight}
          keyboardViewportRevision={keyboardViewportRevision}
          messages={messages}
          mode={detailMode}
          onModeChange={setDetailMode}
          onRetryTimeline={(turn) => mobileAiSessionStore.retryTurnTimeline(controlPlaneId, instanceId, session.id, turn)}
          onContinueFromTurn={continueFromTurn}
          onVisible={onVisible}
          onTurnIndexChange={setSelectedTurnIndex}
          session={session}
          showModePicker={controlledDetailMode === undefined}
          timelineEnabled={supportsTurnTimeline || supportsSessionTimeline || supportsLiveTimeline}
          timelineHistoryEnabled={supportsTurnTimeline || supportsSessionTimeline}
          timelines={timelines}
          turnIndex={selectedTurnIndex}
        />
      </View>
      <>
        <Animated.View pointerEvents="none" style={[styles.composerBackdrop, { bottom: composerFadeBottom, height: 16 }]} testID="session-composer-fade-backdrop">
          <Svg height="100%" width="100%">
            <Defs>
              <LinearGradient id="session-composer-gradient" x1="0" x2="0" y1="0" y2="100%">
                <Stop offset={0} stopColor={colors.surface} stopOpacity={COMPOSER_BACKDROP_OPACITIES.fade[0]} />
                <Stop offset={1} stopColor={colors.surface} stopOpacity={COMPOSER_BACKDROP_OPACITIES.fade[1]} />
              </LinearGradient>
            </Defs>
            <Rect fill="url(#session-composer-gradient)" height="100%" width="100%" />
          </Svg>
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.composerBackdrop, { backgroundColor: colors.surface, bottom: composerBottomInset, height: composerBackdropHeight, opacity: COMPOSER_BACKDROP_OPACITIES.composer }]} testID="session-composer-backdrop" />
        <View pointerEvents="none" style={[styles.composerBackdrop, { bottom: 0, height: bottomBackdrop.height }]} testID="session-composer-bottom-backdrop">
          <Svg height="100%" width="100%">
            <Defs>
              <LinearGradient id="session-composer-bottom-gradient" x1="0" x2="0" y1="0" y2="100%">
                <Stop offset={bottomBackdrop.locations[0]} stopColor={colors.surface} stopOpacity={COMPOSER_BACKDROP_OPACITIES.bottom[0]} />
                <Stop offset={bottomBackdrop.locations[1]} stopColor={colors.surface} stopOpacity={COMPOSER_BACKDROP_OPACITIES.bottom[1]} />
                <Stop offset={bottomBackdrop.locations[2]} stopColor={colors.surface} stopOpacity={COMPOSER_BACKDROP_OPACITIES.bottom[2]} />
              </LinearGradient>
            </Defs>
            <Rect fill="url(#session-composer-bottom-gradient)" height="100%" width="100%" />
          </Svg>
        </View>
      </>
      <View onLayout={(event) => setComposerOverlayHeight(event.nativeEvent.layout.height)} style={[styles.actions, { paddingBottom: composerBottomInset }]} testID="session-actions">
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
                    { text: decisionLabel, onPress: () => { if (actions) void performAction(decisionLabel, () => actions.approval(instanceId, session.id, decision)); } },
                  ]);
                }} />
              ))}
            </View>
          </View>
        ) : null}
        {isLatestTurn && session.queue.items.length ? <View style={[styles.queueListFrame, { backgroundColor: colors.surface, borderColor: colors.border }]}><FlatList
          accessibilityLabel={t('workspace.queuedMessages')}
          data={displayedQueueItems}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          scrollEnabled={queueListScrollEnabled(draggingQueueId)}
          style={styles.queueList}
          testID="queued-message-list"
          ItemSeparatorComponent={() => <View style={[styles.queueSeparator, { backgroundColor: colors.border }]} />}
          renderItem={({ item }) => {
            const metadata = [
              item.status === 'failed' ? t('workspace.queueFailed') : undefined,
              item.permissionMode ? queuePermissionLabel(item.permissionMode, t) : undefined,
              item.attachments.length ? t('workspace.queueAttachments', { count: item.attachments.length }) : undefined,
              item.references.length ? t('workspace.queueReferences', { count: item.references.length }) : undefined,
            ].filter(Boolean).join(' · ');
            return (
              <View
                onLayout={(event) => queueRowHeights.current.set(item.id, event.nativeEvent.layout.height)}
                style={[styles.queueRow, draggingQueueId === item.id && styles.queueRowDragging, draggingQueueId === item.id && { transform: [{ translateY: queueDragOffsetY }], zIndex: 1 }]}
                testID={`queued-message-row-${item.id}`}
              >
                <View style={styles.queueContent}>
                  {item.status === 'queued' ? <QueueDragHandle
                    disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('queue-reorder')?.phase || '')}
                    label={t('workspace.reorderAction')}
                    moveDownLabel={t('workspace.moveDownAction')}
                    moveUpLabel={t('workspace.moveUpAction')}
                    onDragCancel={() => cancelQueueDrag(item.id)}
                    onDragEnd={() => finishQueueDrag(item.id)}
                    onDragMove={(dy) => updateQueueDrag(item.id, dy)}
                    onDragStart={() => beginQueueDrag(item.id)}
                    onMoveDown={() => moveQueuedMessage(item.id, 1)}
                    onMoveUp={() => moveQueuedMessage(item.id, -1)}
                  /> : <GripVertical color={colors.error} size={mobileWebMetric(17)} strokeWidth={1.8} />}
                  <View style={styles.queueCopy}>
                    <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.queueText, { color: colors.text }]}>{item.message}</Text>
                    {metadata ? <Text numberOfLines={1} style={[styles.queueMeta, { color: colors.textMuted }]}>{metadata}</Text> : null}
                    {item.error ? <Text numberOfLines={2} style={[styles.error, styles.queueError, { color: colors.error }]}>{item.error}</Text> : null}
                  </View>
                </View>
                <View style={styles.queueActions}>
                  {item.status === 'queued' ? <QueueActionButton icon={queueActionIcon('edit')} label={t('workspace.editAction')} disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('queue-edit', item.id)?.phase || '')} onPress={() => beginQueueEdit(item.id, item.message)} /> : null}
                  <QueueActionButton icon={queueActionIcon('steer')} label={t('workspace.steerAction')} disabled={!authoritativeActionsEnabled || !actions || !canInterrupt || ['busy', 'result-unknown'].includes(state('queue-steer', item.id)?.phase || '')} onPress={() => { if (actions) void performAction(t('workspace.steerAction'), () => actions.queue(instanceId, session.id, item.id, 'steer')); }} showLabel />
                  {item.status === 'failed' ? <QueueActionButton icon={queueActionIcon('retry')} label={t('workspace.retryAction')} disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('queue-retry', item.id)?.phase || '')} onPress={() => { if (actions) void performAction(t('workspace.retryAction'), () => actions.queue(instanceId, session.id, item.id, 'retry')); }} /> : null}
                  <QueueActionButton destructive icon={queueActionIcon('remove')} label={t('workspace.removeAction')} disabled={!authoritativeActionsEnabled || !actions || ['busy', 'result-unknown'].includes(state('queue-remove', item.id)?.phase || '')} onPress={() => { if (actions) void performAction(t('workspace.removeAction'), () => actions.queue(instanceId, session.id, item.id, 'remove')); }} />
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
        {attachments.length ? <View style={styles.attachments}>{attachments.map((attachment) => <View key={attachment.localId} style={[styles.attachment, { backgroundColor: colors.surfaceMuted }]}>
          <SystemIcon android={attachment.kind === 'image' ? 'image' : 'description'} color={colors.textMuted} ios={attachment.kind === 'image' ? 'photo' : attachment.textPresentation ? 'doc.plaintext' : 'doc'} size={17} />
          <View accessible accessibilityLabel={attachment.textPresentation ? `${attachment.name}, ${attachment.textPresentation.summary || t('composer.blankPastedText')}, ${t('composer.textLength', { count: formatMobileTextLength(attachment.textPresentation.codePointLength, locale) })}, ${formatMobileAttachmentBytes(attachment.size, locale)}` : attachment.name} style={styles.attachmentCopy}>
            <Text numberOfLines={1} style={[styles.attachmentName, { color: colors.text }]}>{attachment.name}</Text>
            {attachment.textPresentation ? <Text numberOfLines={1} style={[styles.attachmentSummary, { color: colors.text }]}>{attachment.textPresentation.summary || t('composer.blankPastedText')}</Text> : null}
            <Text numberOfLines={1} style={[styles.attachmentMeta, { color: attachment.phase === 'failed' || attachment.phase === 'result-unknown' ? colors.error : colors.textMuted }]}>
              {attachment.textPresentation ? `${t('composer.textLength', { count: formatMobileTextLength(attachment.textPresentation.codePointLength, locale) })} · ` : ''}{formatMobileAttachmentBytes(attachment.size, locale)} · {attachment.phase}
            </Text>
            {attachment.error ? <Text accessibilityLiveRegion="polite" numberOfLines={2} style={[styles.error, { color: colors.error }]}>{attachment.error}</Text> : null}
          </View>
          {attachment.retryLocal ? <Pressable accessibilityLabel={t('common.retry')} accessibilityRole="button" hitSlop={8} onPress={() => { void retryAttachment(attachment); }}><RotateCcw color={colors.primary} size={16} /></Pressable> : null}
          <Pressable accessibilityLabel={`Remove ${attachment.name}`} accessibilityRole="button" hitSlop={8} onPress={() => removeAttachment(attachment)}><SystemIcon android="close" color={colors.textMuted} ios="xmark.circle.fill" size={17} /></Pressable>
        </View>)}</View> : null}
        <SessionComposer
          action={composerAction}
          actionBusy={composerBusy}
          actionDisabled={composerDisabled}
          editable={authoritativeActionsEnabled}
          editingLabel={activeQueueEdit ? t('workspace.editMessage') : undefined}
          expansion={composerExpansion}
          fileDisabled={!authoritativeActionsEnabled || !client}
          focused={composerFocused}
          focusRequestKey={composerFocusRequest}
          imageDisabled={!authoritativeActionsEnabled || !client}
          onAction={runComposerAction}
          onAddFile={() => { void selectLocal('file'); }}
          onAddImage={() => { void selectLocal('image'); }}
          onAddRuntimeFile={() => { void loadRuntimeFiles(); }}
          onPasteImages={(uris) => { void pasteImages(uris); }}
          onPasteText={(text) => { void pasteText(text); }}
          onCancelEdit={() => { if (activeQueueEdit) restoreDraftAfterQueueEdit(activeQueueEdit); }}
          onFocusChange={setComposerFocus}
          onPermissionModeChange={updatePermissionMode}
          onValueChange={updateDraft}
          permissionEnabled={session.agent === 'codex'}
          permissionMode={permissionMode}
          runtimeFileDisabled={!authoritativeActionsEnabled || !client || !session.cwd}
          value={draft}
        />
      </View>
      </KeyboardAvoidingView>
    </View>
  );
}

export function sessionKeyboardAvoidingBehavior(platform: string): 'height' | undefined {
  return platform === 'ios' ? 'height' : undefined;
}

export const COMPOSER_BACKDROP_OPACITIES = {
  fade: [0, 0.8],
  composer: 0.8,
  bottom: [0.8, 1, 1],
} as const;

export function composerBottomBackdropGeometry(bottomInset: number) {
  if (bottomInset <= 0) return { height: 0, locations: [0, 1, 1] as const };
  return {
    height: bottomInset,
    locations: [0, Math.max(0, 1 - 8 / bottomInset), 1] as const,
  };
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

function QueueActionButton({ label, icon: Icon, destructive = false, disabled, onPress, showLabel = false }: { label: string; icon: LucideIcon; destructive?: boolean; disabled?: boolean; onPress(): void; showLabel?: boolean }) {
  const { colors } = useMobileTheme();
  const color = destructive ? colors.error : colors.primary;
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} hitSlop={5} onPress={onPress} style={({ pressed }) => [styles.queueAction, disabled && styles.disabled, pressed && styles.pressed]}><Icon color={color} size={mobileWebMetric(15)} />{showLabel ? <Text style={[styles.queueActionText, { color }]}>{label}</Text> : null}</Pressable>;
}

export function queueActionIcon(action: 'edit' | 'steer' | 'retry' | 'remove'): LucideIcon {
  if (action === 'edit') return Pencil;
  if (action === 'steer') return CornerDownRight;
  if (action === 'retry') return RotateCcw;
  return Trash2;
}

function QueueDragHandle({ disabled, label, moveDownLabel, moveUpLabel, onDragCancel, onDragEnd, onDragMove, onDragStart, onMoveDown, onMoveUp }: { disabled?: boolean; label: string; moveDownLabel: string; moveUpLabel: string; onDragCancel(): void; onDragEnd(): void; onDragMove(dy: number): void; onDragStart(): void; onMoveDown(): void; onMoveUp(): void }) {
  const { colors } = useMobileTheme();
  const callbacks = useRef({ onDragCancel, onDragEnd, onDragMove, onDragStart });
  const disabledRef = useRef(disabled);
  useLayoutEffect(() => {
    callbacks.current = { onDragCancel, onDragEnd, onDragMove, onDragStart };
    disabledRef.current = disabled;
  }, [disabled, onDragCancel, onDragEnd, onDragMove, onDragStart]);
  // PanResponder stores these functions for native events; the refs are only read after a gesture event fires.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: () => !disabledRef.current,
    onMoveShouldSetPanResponder: () => !disabledRef.current,
    onPanResponderGrant: () => callbacks.current.onDragStart(),
    onPanResponderMove: (_event, gesture) => callbacks.current.onDragMove(gesture.dy),
    onPanResponderRelease: () => callbacks.current.onDragEnd(),
    onPanResponderTerminate: () => callbacks.current.onDragCancel(),
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onStartShouldSetPanResponderCapture: () => !disabledRef.current,
    onStartShouldSetPanResponder: () => !disabledRef.current,
  }));
  return (
    <View
      accessibilityActions={[{ name: 'decrement', label: moveUpLabel }, { name: 'increment', label: moveDownLabel }]}
      accessibilityLabel={label}
      accessibilityRole="adjustable"
      accessibilityState={{ disabled: Boolean(disabled) }}
      onAccessibilityAction={(event) => {
        if (disabled) return;
        if (event.nativeEvent.actionName === 'decrement') onMoveUp();
        if (event.nativeEvent.actionName === 'increment') onMoveDown();
      }}
      style={[styles.queueDragHandle, disabled && styles.disabled]}
      testID="queue-drag-handle"
      {...responder.panHandlers}
    >
      <GripVertical color={colors.textMuted} size={mobileWebMetric(17)} strokeWidth={1.8} />
    </View>
  );
}

export function moveQueueId(queueIds: readonly string[], source: number, target: number) {
  if (source < 0 || target < 0 || source >= queueIds.length || target >= queueIds.length || source === target) return [...queueIds];
  const reordered = [...queueIds];
  const [item] = reordered.splice(source, 1);
  reordered.splice(target, 0, item);
  return reordered;
}

export function queueDragPreview(
  sourceIds: readonly string[],
  queueId: string,
  sourceCenter: number,
  targets: readonly { index: number; center: number }[],
  dy: number,
) {
  const pointerCenter = sourceCenter + dy;
  const target = targets.reduce((closest, candidate) => (
    Math.abs(candidate.center - pointerCenter) < Math.abs(closest.center - pointerCenter) ? candidate : closest
  ));
  return {
    queueIds: moveQueueId(sourceIds, sourceIds.indexOf(queueId), target.index),
    offsetY: pointerCenter - target.center,
  };
}

export function queueListScrollEnabled(draggingQueueId?: string) {
  return !draggingQueueId;
}

export function queueItemsWithQueuedOrder<T extends { id: string; status: string }>(items: readonly T[], queueIds?: readonly string[]) {
  if (!queueIds) return [...items];
  const queuedById = new Map(items.filter((item) => item.status === 'queued').map((item) => [item.id, item]));
  const ordered = queueIds.map((id) => queuedById.get(id)).filter((item): item is T => Boolean(item));
  let queuedIndex = 0;
  return items.map((item) => item.status === 'queued' ? ordered[queuedIndex++] || item : item);
}

function arraysEqual(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  return left?.length === right?.length && left?.every((value, index) => value === right?.[index]);
}

function queuePermissionLabel(mode: AiSessionPermissionMode, t: Translate) {
  if (mode === 'auto-review') return t('composer.autoReview');
  if (mode === 'full-access') return t('composer.fullAccess');
  return t('composer.ask');
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  actions: { bottom: 0, gap: 8, left: 0, paddingHorizontal: 12, paddingTop: 16, position: 'absolute', right: 0, zIndex: 10 },
  composerBackdrop: { left: 0, position: 'absolute', right: 0, zIndex: 9 },
  actionRow: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  approval: { borderRadius: 14, gap: 8, padding: 10 },
  approvalTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 7, paddingHorizontal: 2 },
  approvalTitle: { fontSize: 14, fontWeight: '700', lineHeight: 19 },
  approvalButton: { alignItems: 'center', borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, flex: 1, flexDirection: 'row', gap: 5, justifyContent: 'center', minHeight: 38, paddingHorizontal: 8 },
  approvalButtonText: { fontSize: mobileWebType.small, fontWeight: '700', lineHeight: mobileWebType.smallLine },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  queueListFrame: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  queueList: { maxHeight: 224 },
  queueSeparator: { height: StyleSheet.hairlineWidth, marginLeft: 30 },
  queueRow: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 52, paddingHorizontal: 7, paddingVertical: 8 },
  queueRowDragging: { opacity: 0.72 },
  queueContent: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 4, minWidth: 0 },
  queueCopy: { flex: 1, gap: 1, minWidth: 0 },
  queueText: { fontSize: mobileWebType.meta, fontWeight: '500', lineHeight: mobileWebType.metaLine },
  queueMeta: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine },
  queueError: { marginTop: 1 },
  queueActions: { alignItems: 'center', flexDirection: 'row', gap: 2 },
  queueDragHandle: { alignItems: 'center', height: 40, justifyContent: 'center', width: 24 },
  queueAction: { alignItems: 'center', borderRadius: 8, flexDirection: 'row', gap: 4, height: 34, justifyContent: 'center', minWidth: 34, paddingHorizontal: 6 },
  queueActionText: { fontSize: mobileWebType.small, fontWeight: '700', lineHeight: mobileWebType.smallLine },
  notice: { alignItems: 'flex-start', borderRadius: 10, flexDirection: 'row', gap: 8, padding: 12 },
  noticeText: { flex: 1, fontSize: mobileWebType.meta, lineHeight: mobileWebType.metaLine },
  error: { color: '#b91c1c', fontSize: mobileWebType.meta, lineHeight: mobileWebType.metaLine },
  attachments: { gap: 8 },
  attachment: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  attachmentCopy: { flex: 1, minWidth: 0 },
  attachmentName: { fontSize: mobileWebType.meta, fontWeight: '500', lineHeight: mobileWebType.metaLine },
  attachmentSummary: { fontSize: 12, fontWeight: '400', lineHeight: 17 },
  attachmentMeta: { fontSize: 12, fontWeight: '400', lineHeight: 17 },
  runtimeFiles: { backgroundColor: '#f8fafc', borderRadius: 10, maxHeight: 128 }, runtimeFilesContent: { gap: 8, padding: 10 },
  runtimeFile: { color: '#2563eb', fontSize: mobileWebType.meta, lineHeight: mobileWebType.metaLine },
});
