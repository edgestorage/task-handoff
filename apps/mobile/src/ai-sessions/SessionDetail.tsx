import { Profiler, useEffect, useMemo, useState, type ProfilerOnRenderCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { isAiSessionApprovalPending, type ControlPlaneAiSessionSummary } from '@task-handoff/control-plane-client';

import { SafeMarkdown } from '../components/SafeMarkdown';
import { SystemIcon } from '../components/SystemIcon';
import type { MobileStreamingMessage } from './store';
import { mobileMetrics } from '../observability/mobile-metrics';
import { useMobileTheme } from '../components/theme';
import { NativeSessionModePicker } from './NativeSessionModePicker';

type DetailItem = { id: string; role: 'user' | 'assistant' | 'error'; text: string };
export type SessionDetailMode = 'conversation' | 'turn';

export function SessionDetail({
  session,
  messages,
  onVisible,
  turnIndex,
  onTurnIndexChange,
  mode,
  onModeChange,
  bottomInset = 0,
}: {
  session?: ControlPlaneAiSessionSummary;
  messages: readonly MobileStreamingMessage[];
  onVisible?(sessionUpdatedAt: string): void;
  turnIndex?: number;
  onTurnIndexChange?(index: number): void;
  mode?: SessionDetailMode;
  onModeChange?(mode: SessionDetailMode): void;
  bottomInset?: number;
}) {
  const { colors } = useMobileTheme();
  const turns = useMemo(() => aiSessionDisplayTurns(session), [session]);
  const latestIndex = Math.max(0, turns.length - 1);
  const [localTurnIndex, setLocalTurnIndex] = useState(latestIndex);
  const [localMode, setLocalMode] = useState<SessionDetailMode>('turn');
  const selectedMode = mode ?? localMode;
  const selectedIndex = Math.min(Math.max(turnIndex ?? localTurnIndex, 0), latestIndex);
  const isLatest = selectedIndex >= latestIndex;
  const showsLatest = selectedMode === 'conversation' || isLatest;
  const activityText = session ? sessionActivityText(session) : undefined;
  const items = useMemo(() => selectedMode === 'conversation' ? conversationDetailItems(session, messages) : detailItems(session, messages, selectedIndex), [session, messages, selectedIndex, selectedMode]);
  useEffect(() => {
    if (session) onVisible?.(session.updatedAt);
  }, [onVisible, session]);
  const selectTurn = (index: number) => {
    const next = Math.min(Math.max(index, 0), latestIndex);
    if (turnIndex === undefined) setLocalTurnIndex(next);
    onTurnIndexChange?.(next);
  };
  const selectMode = (next: SessionDetailMode) => {
    if (mode === undefined) setLocalMode(next);
    onModeChange?.(next);
  };
  if (!session) return (
    <Profiler id="detail" onRender={recordDetailRender}>
      <View style={[styles.empty, { backgroundColor: colors.background }]}>
        <SystemIcon android="chat_bubble_outline" color={colors.textMuted} ios="bubble.left.and.bubble.right" size={30} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>Session unavailable</Text>
        <Text style={[styles.muted, styles.emptyText, { color: colors.textMuted }]}>This session is not available in the current snapshot.</Text>
      </View>
    </Profiler>
  );
  return (
    <Profiler id="detail" onRender={recordDetailRender}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.list, { backgroundColor: colors.surface, paddingBottom: Math.max(28, bottomInset + 16) }]}
        keyboardDismissMode="interactive"
      >
        <View style={styles.header}>
          {turns.length ? <View style={styles.modePicker}><NativeSessionModePicker mode={selectedMode} onChange={selectMode} /></View> : null}
          <View style={styles.sessionBar}>
            <View style={styles.metaRow}>
              <View style={[styles.statusDot, { backgroundColor: statusColor(session.status, colors.primary, colors.textMuted, colors.error) }]} />
              <Text style={[styles.meta, { color: colors.textMuted }]}>{statusLabel(session.status, activityText ? 'unknown' : session.phase)}</Text>
            </View>
            {selectedMode === 'turn' && turns.length > 1 ? <View style={styles.turnNavigator}>
              <Pressable accessibilityLabel="Previous turn" accessibilityRole="button" accessibilityState={{ disabled: selectedIndex <= 0 }} disabled={selectedIndex <= 0} hitSlop={8} onPress={() => selectTurn(selectedIndex - 1)} style={[styles.turnButton, selectedIndex <= 0 && styles.turnButtonDisabled]}><SystemIcon android="chevron_left" color={colors.primary} ios="chevron.left" size={14} /></Pressable>
              <Text style={[styles.turnIndex, { color: colors.textMuted }]}>{selectedIndex + 1} / {turns.length}</Text>
              <Pressable accessibilityLabel="Next turn" accessibilityRole="button" accessibilityState={{ disabled: isLatest }} disabled={isLatest} hitSlop={8} onPress={() => selectTurn(selectedIndex + 1)} style={[styles.turnButton, isLatest && styles.turnButtonDisabled]}><SystemIcon android="chevron_right" color={colors.primary} ios="chevron.right" size={14} /></Pressable>
            </View> : null}
          </View>
        </View>
        {!items.length ? <View style={styles.conversationEmpty}><Text style={[styles.muted, { color: colors.textMuted }]}>No messages in this session yet.</Text></View> : items.map((item) => selectedMode === 'conversation' && item.role === 'user' ? (
          <View key={item.id} style={[styles.conversationUser, { backgroundColor: colors.primarySoft }]}><SafeMarkdown>{item.text}</SafeMarkdown></View>
        ) : selectedMode === 'conversation' && item.role === 'assistant' ? (
          <View key={item.id} style={styles.conversationResponse}><SafeMarkdown>{item.text}</SafeMarkdown></View>
        ) : item.role === 'user' ? (
          <View key={item.id} style={[styles.promptBlock, { backgroundColor: colors.primarySoft }]}><SafeMarkdown>{item.text}</SafeMarkdown></View>
        ) : item.role === 'assistant' ? (
          <View key={item.id} style={styles.responseBlock}><SafeMarkdown>{item.text}</SafeMarkdown></View>
        ) : <View key={item.id} style={[styles.errorBlock, { backgroundColor: colors.errorSoft }]}><SystemIcon android="error" color={colors.error} ios="exclamationmark.triangle.fill" size={16} /><View style={styles.errorText}><Text style={[styles.role, { color: colors.error }]}>Session error</Text><SafeMarkdown>{item.text}</SafeMarkdown></View></View>)}
          {showsLatest && activityText ? <View style={styles.tool}><SystemIcon android="auto_awesome" color={colors.textMuted} ios="sparkles" size={14} /><Text numberOfLines={2} style={[styles.toolTitle, { color: colors.textMuted }]}>{activityText}</Text></View> : null}
        <SubAgents agents={session.subAgents} />
      </ScrollView>
    </Profiler>
  );
}

const recordDetailRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  mobileMetrics.record('render.duration', { screen: 'detail' }, actualDuration);
};

export function detailItems(session: ControlPlaneAiSessionSummary | undefined, messages: readonly MobileStreamingMessage[], turnIndex?: number): DetailItem[] {
  if (!session) return [];
  const turns = aiSessionDisplayTurns(session);
  if (turns.length) {
    const index = Math.min(Math.max(turnIndex ?? turns.length - 1, 0), turns.length - 1);
    const turn = turns[index];
    const isLatest = index >= turns.length - 1;
    const items: DetailItem[] = [];
    if (turn.userPrompt?.trim()) items.push({ id: `${turn.id}:user`, role: 'user', text: turn.userPrompt });
    const streamed = isLatest
      ? messages.filter((message) => message.turnId === turn.id).sort((a, b) => a.itemId.localeCompare(b.itemId))
      : [];
    const streamedText = streamed.map((message) => message.receivedText.trim()).filter(Boolean).join('\n\n');
    const response = streamedText || turn.lastMessage?.trim() || turn.summary?.trim();
    if (response) items.push({ id: `${turn.id}:assistant`, role: 'assistant', text: response });
    if (isLatest && session.status === 'failed') items.push({ id: 'session:error', role: 'error', text: 'Session failed. Open the desktop app for diagnostic details.' });
    return items;
  }
  const items: DetailItem[] = [];
  if (session.userPrompt) items.push({ id: 'session:user', role: 'user', text: session.userPrompt });
  if (session.lastMessage || session.summary) items.push({ id: 'session:assistant', role: 'assistant', text: session.lastMessage || session.summary! });
  if (session.status === 'failed') items.push({ id: 'session:error', role: 'error', text: 'Session failed. Open the desktop app for diagnostic details.' });
  return items;
}

export function conversationDetailItems(session: ControlPlaneAiSessionSummary | undefined, messages: readonly MobileStreamingMessage[]): DetailItem[] {
  const turns = aiSessionDisplayTurns(session);
  if (!turns.length) return detailItems(session, messages);
  return turns.flatMap((_turn, index) => detailItems(session, messages, index));
}

export function aiSessionDisplayTurns(session: ControlPlaneAiSessionSummary | undefined) {
  return (session?.turns ?? []).filter((turn) => turn.userPrompt?.trim() || turn.lastMessage?.trim() || turn.summary?.trim() || turn.contextCompactions?.length);
}

export function sessionActivityText(session: ControlPlaneAiSessionSummary) {
  if (!['running', 'waiting'].includes(session.status) || isAiSessionApprovalPending(session)) return undefined;
  if (session.currentTool?.name) return session.currentTool.inputPreview
    ? `${session.currentTool.name} · ${session.currentTool.inputPreview}`
    : session.currentTool.name;
  if (session.phase === 'responding') return 'Responding…';
  if (session.phase === 'editing') return 'Editing…';
  if (session.status === 'waiting') return 'Waiting…';
  return session.toolCallsSinceLastMessage > 0 ? `Thinking · ${session.toolCallsSinceLastMessage} tool calls` : 'Thinking…';
}

function statusColor(status: ControlPlaneAiSessionSummary['status'], active: string, muted: string, error: string) {
  if (status === 'failed') return error;
  if (status === 'running' || status === 'waiting') return active;
  return muted;
}

function statusLabel(status: ControlPlaneAiSessionSummary['status'], phase: ControlPlaneAiSessionSummary['phase']) {
  const statusText = status.charAt(0).toUpperCase() + status.slice(1);
  const phaseText = phase === 'unknown' ? '' : ` · ${phase.charAt(0).toUpperCase() + phase.slice(1)}`;
  return `${statusText}${phaseText}`;
}

function SubAgents({ agents }: { agents: ControlPlaneAiSessionSummary['subAgents'] }) {
  const { colors } = useMobileTheme();
  const active = agents.filter((agent) => ['pending-init', 'running', 'interrupted', 'errored', 'not-found'].includes(agent.status));
  const [userExpanded, setUserExpanded] = useState<boolean>();
  const expanded = userExpanded ?? active.length > 0;
  if (!agents.length) return null;
  return (
    <View style={[styles.subAgents, { borderTopColor: colors.border }]}> 
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setUserExpanded(!expanded)} style={styles.subAgentHeader}>
        <View style={[styles.avatar, { backgroundColor: colors.surfaceMuted }]}>
          <SystemIcon android="account_tree" color={colors.primary} ios="point.3.connected.trianglepath.dotted" size={16} />
        </View>
        <Text style={[styles.subAgentTitle, { color: colors.text }]}>Sub-agents ({agents.length}) · {expanded ? 'Hide' : 'Show'}</Text>
        <SystemIcon android={expanded ? 'expand_less' : 'expand_more'} color={colors.textMuted} ios={expanded ? 'chevron.up' : 'chevron.down'} size={14} />
      </Pressable>
      {expanded ? agents.slice(0, 50).map((agent) => (
        <View key={agent.threadId} style={[styles.subAgent, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
          <View style={styles.subAgentNameRow}>
            <View style={[styles.statusDot, { backgroundColor: ['running', 'pending-init'].includes(agent.status) ? colors.primary : colors.textMuted }]} />
            <Text numberOfLines={1} style={[styles.subAgentName, { color: colors.text }]}>{agent.path || agent.threadId}</Text>
          </View>
          <Text style={[styles.meta, { color: colors.textMuted }]}>{agent.status} · {agent.activity || 'activity unknown'} · {new Date(agent.updatedAt).toLocaleString()}</Text>
          <Text style={[styles.muted, { color: colors.textMuted }]}>{agent.message || 'No message available.'}</Text>
        </View>
      )) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { flexGrow: 1, gap: 16, paddingHorizontal: 16, paddingBottom: 28, paddingTop: 10 },
  empty: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 17, fontWeight: '700' },
  emptyText: { maxWidth: 260, textAlign: 'center' },
  header: { gap: 10, marginBottom: 2 },
  modePicker: { alignItems: 'center' },
  sessionBar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 32 },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  turnNavigator: { alignItems: 'center', flexDirection: 'row', gap: 2 },
  turnButton: { alignItems: 'center', height: 30, justifyContent: 'center', width: 30 },
  turnButtonDisabled: { opacity: 0.3 },
  turnIndex: { fontSize: 12, fontVariant: ['tabular-nums'], fontWeight: '600', minWidth: 42, textAlign: 'center' },
  statusDot: { borderRadius: 4, height: 8, width: 8 },
  meta: { fontSize: 12, lineHeight: 17, textTransform: 'capitalize' },
  muted: { fontSize: 12, lineHeight: 18 },
  tool: { alignItems: 'center', flexDirection: 'row', gap: 7, minHeight: 28, paddingHorizontal: 2 },
  toolBody: { flex: 1, gap: 3 },
  toolTitle: { flex: 1, fontSize: 13, fontWeight: '500' },
  conversationEmpty: { alignItems: 'center', paddingVertical: 32 },
  avatar: { alignItems: 'center', borderRadius: 10, height: 28, justifyContent: 'center', width: 28 },
  promptBlock: { alignSelf: 'flex-end', borderRadius: 18, borderTopRightRadius: 6, maxWidth: '88%', paddingHorizontal: 14, paddingVertical: 10 },
  responseBlock: { alignSelf: 'stretch', paddingHorizontal: 2, paddingVertical: 2 },
  conversationUser: { alignSelf: 'flex-end', borderRadius: 16, borderTopRightRadius: 5, maxWidth: '88%', paddingHorizontal: 13, paddingVertical: 10 },
  conversationResponse: { alignSelf: 'flex-start', maxWidth: '98%', paddingHorizontal: 2, paddingVertical: 4 },
  errorBlock: { alignItems: 'flex-start', borderRadius: 10, flexDirection: 'row', gap: 8, padding: 10 },
  errorText: { flex: 1, gap: 5 },
  role: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  subAgents: { borderTopWidth: StyleSheet.hairlineWidth, gap: 9, marginTop: 8, paddingTop: 14 },
  subAgentHeader: { alignItems: 'center', flexDirection: 'row', gap: 9, minHeight: 44 },
  subAgentTitle: { flex: 1, fontSize: 15, fontWeight: '700' },
  subAgent: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 5, padding: 11 },
  subAgentNameRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  subAgentName: { flex: 1, fontSize: 13, fontWeight: '600' },
});
