import { Profiler, useEffect, useMemo, useState, type ProfilerOnRenderCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ScrollViewMarker } from 'react-native-screens/experimental';
import { isAiSessionApprovalPending, type ControlPlaneAiSessionSummary } from '@task-handoff/control-plane-client';

import { SafeMarkdown } from '../components/SafeMarkdown';
import { SystemIcon } from '../components/SystemIcon';
import { activeMobileStreamingMessage, type MobileStreamingMessage } from './store';
import { mobileMetrics } from '../observability/mobile-metrics';
import { useMobileTheme } from '../components/theme';
import { NativeSessionModePicker } from './NativeSessionModePicker';
import { ToolActivityText } from './ToolActivityText';
import { translate, useI18n, type Translate } from '../i18n';

const english: Translate = (key, params) => translate('en-US', key, params);

type DetailItem = { id: string; role: 'user' | 'assistant' | 'error'; streamKey?: string; streaming?: boolean; text: string };
export type SessionDetailMode = 'conversation' | 'turn';

export function SessionDetail({
  session,
  messages,
  onVisible,
  turnIndex,
  onTurnIndexChange,
  mode,
  onModeChange,
  showModePicker = true,
  bottomInset = 0,
}: {
  session?: ControlPlaneAiSessionSummary;
  messages: readonly MobileStreamingMessage[];
  onVisible?(sessionUpdatedAt: string): void;
  turnIndex?: number;
  onTurnIndexChange?(index: number): void;
  mode?: SessionDetailMode;
  onModeChange?(mode: SessionDetailMode): void;
  showModePicker?: boolean;
  bottomInset?: number;
}) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const turns = useMemo(() => aiSessionDisplayTurns(session), [session]);
  const latestIndex = Math.max(0, turns.length - 1);
  const [localTurnIndex, setLocalTurnIndex] = useState(latestIndex);
  const [localMode, setLocalMode] = useState<SessionDetailMode>('turn');
  const selectedMode = mode ?? localMode;
  const selectedIndex = Math.min(Math.max(turnIndex ?? localTurnIndex, 0), latestIndex);
  const isLatest = selectedIndex >= latestIndex;
  const showsLatest = selectedMode === 'conversation' || isLatest;
  const activityText = session ? sessionActivityText(session, t) : undefined;
  const items = useMemo(() => selectedMode === 'conversation' ? conversationDetailItems(session, messages, t) : detailItems(session, messages, selectedIndex, t), [session, messages, selectedIndex, selectedMode, t]);
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
        <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('sessions.unavailable')}</Text>
        <Text style={[styles.muted, styles.emptyText, { color: colors.textMuted }]}>{t('sessions.unavailableDescription')}</Text>
      </View>
    </Profiler>
  );
  return (
    <Profiler id="detail" onRender={recordDetailRender}>
      <ScrollViewMarker scrollEdgeEffects={{ top: 'soft' }} style={[styles.fill, { backgroundColor: colors.surface }]}>
        <FlatList
          contentContainerStyle={[styles.list, { backgroundColor: colors.surface, paddingBottom: Math.max(28, bottomInset + 16) }]}
          contentInsetAdjustmentBehavior="automatic"
          data={items}
          initialNumToRender={6}
          ItemSeparatorComponent={DetailItemSeparator}
          keyExtractor={(item) => item.id}
          keyboardDismissMode="interactive"
          ListEmptyComponent={<View style={styles.conversationEmpty}><Text style={[styles.muted, { color: colors.textMuted }]}>{t('sessions.noMessages')}</Text></View>}
          ListFooterComponent={showsLatest && activityText || session.subAgents.length ? <View style={styles.footer}>
            {showsLatest && activityText ? <View style={styles.tool}><SystemIcon android="auto_awesome" color={colors.textMuted} ios="sparkles" size={14} /><ToolActivityText containerStyle={styles.toolText} numberOfLines={1} running={session.status === 'running'} textStyle={styles.toolTitle}>{activityText}</ToolActivityText></View> : null}
            <SubAgents agents={session.subAgents} locale={locale} />
          </View> : null}
          ListHeaderComponent={<View style={styles.header}>
            {showModePicker && turns.length ? <View style={styles.modePicker}><NativeSessionModePicker mode={selectedMode} onChange={selectMode} /></View> : null}
            <View style={styles.sessionBar}>
              <View style={styles.metaRow}>
                <View style={[styles.statusDot, { backgroundColor: statusColor(session.status, colors.primary, colors.textMuted, colors.error) }]} />
                <Text style={[styles.meta, { color: colors.textMuted }]}>{statusLabel(session.status, activityText ? 'unknown' : session.phase)}</Text>
              </View>
              {selectedMode === 'turn' && turns.length > 1 ? <View style={styles.turnNavigator}>
                <Pressable accessibilityLabel={t('sessions.previousTurn')} accessibilityRole="button" accessibilityState={{ disabled: selectedIndex <= 0 }} disabled={selectedIndex <= 0} hitSlop={8} onPress={() => selectTurn(selectedIndex - 1)} style={[styles.turnButton, selectedIndex <= 0 && styles.turnButtonDisabled]}><SystemIcon android="chevron_left" color={colors.primary} ios="chevron.left" size={14} /></Pressable>
                <Text style={[styles.turnIndex, { color: colors.textMuted }]}>{selectedIndex + 1} / {turns.length}</Text>
                <Pressable accessibilityLabel={t('sessions.nextTurn')} accessibilityRole="button" accessibilityState={{ disabled: isLatest }} disabled={isLatest} hitSlop={8} onPress={() => selectTurn(selectedIndex + 1)} style={[styles.turnButton, isLatest && styles.turnButtonDisabled]}><SystemIcon android="chevron_right" color={colors.primary} ios="chevron.right" size={14} /></Pressable>
              </View> : null}
            </View>
          </View>}
          maxToRenderPerBatch={6}
          renderItem={({ item }) => selectedMode === 'conversation' && item.role === 'user' ? (
            <View style={[styles.conversationUser, { backgroundColor: colors.primarySoft }]}><SafeMarkdown trimEnd>{item.text}</SafeMarkdown></View>
          ) : selectedMode === 'conversation' && item.role === 'assistant' ? (
            <View style={styles.conversationResponse}><SafeMarkdown streamKey={item.streamKey} streaming={item.streaming}>{item.text}</SafeMarkdown></View>
          ) : item.role === 'user' ? (
            <View style={[styles.promptBlock, { backgroundColor: colors.primarySoft }]}><SafeMarkdown trimEnd>{item.text}</SafeMarkdown></View>
          ) : item.role === 'assistant' ? (
            <View style={styles.responseBlock}><SafeMarkdown streamKey={item.streamKey} streaming={item.streaming}>{item.text}</SafeMarkdown></View>
          ) : <View style={[styles.errorBlock, { backgroundColor: colors.errorSoft }]}><SystemIcon android="error" color={colors.error} ios="exclamationmark.triangle.fill" size={16} /><View style={styles.errorText}><Text style={[styles.role, { color: colors.error }]}>{t('sessions.error')}</Text><SafeMarkdown>{item.text}</SafeMarkdown></View></View>}
          style={[styles.fill, { backgroundColor: colors.surface }]}
          testID="session-detail-scroll"
          windowSize={7}
        />
      </ScrollViewMarker>
    </Profiler>
  );
}

function DetailItemSeparator() {
  return <View style={styles.itemSeparator} />;
}

const recordDetailRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  mobileMetrics.record('render.duration', { screen: 'detail' }, actualDuration);
};

export function detailItems(session: ControlPlaneAiSessionSummary | undefined, messages: readonly MobileStreamingMessage[], turnIndex?: number, t: Translate = english): DetailItem[] {
  if (!session) return [];
  const turns = aiSessionDisplayTurns(session);
  if (turns.length) {
    const index = Math.min(Math.max(turnIndex ?? turns.length - 1, 0), turns.length - 1);
    const turn = turns[index];
    const isLatest = index >= turns.length - 1;
    const items: DetailItem[] = [];
    if (turn.userPrompt?.trim()) items.push({ id: `${turn.id}:user`, role: 'user', text: turn.userPrompt });
    const streamed = isLatest ? activeMobileStreamingMessage(messages, turn.id) : undefined;
    const hasStreamedText = Boolean(streamed?.receivedText.trim());
    const response = hasStreamedText ? streamed!.receivedText : turn.lastMessage?.trim() || turn.summary?.trim();
    if (response) items.push({
      id: `${turn.id}:assistant`,
      role: 'assistant',
      streamKey: hasStreamedText ? `${turn.id}:${streamed!.itemId}` : undefined,
      streaming: streamed?.status === 'streaming',
      text: response,
    });
    if (isLatest && session.status === 'failed') items.push({ id: 'session:error', role: 'error', text: t('sessions.failedDiagnostic') });
    return items;
  }
  const items: DetailItem[] = [];
  if (session.userPrompt) items.push({ id: 'session:user', role: 'user', text: session.userPrompt });
  if (session.lastMessage || session.summary) items.push({ id: 'session:assistant', role: 'assistant', text: session.lastMessage || session.summary! });
  if (session.status === 'failed') items.push({ id: 'session:error', role: 'error', text: t('sessions.failedDiagnostic') });
  return items;
}

export function conversationDetailItems(session: ControlPlaneAiSessionSummary | undefined, messages: readonly MobileStreamingMessage[], t: Translate = english): DetailItem[] {
  const turns = aiSessionDisplayTurns(session);
  if (!turns.length) return detailItems(session, messages, undefined, t);
  return turns.flatMap((_turn, index) => detailItems(session, messages, index, t));
}

export function aiSessionDisplayTurns(session: ControlPlaneAiSessionSummary | undefined) {
  return (session?.turns ?? []).filter((turn) => turn.userPrompt?.trim() || turn.lastMessage?.trim() || turn.summary?.trim() || turn.contextCompactions?.length);
}

export function sessionActivityText(session: ControlPlaneAiSessionSummary, t: Translate = english) {
  if (!['running', 'waiting'].includes(session.status) || isAiSessionApprovalPending(session)) return undefined;
  if (session.currentTool?.name) return session.currentTool.inputPreview
    ? `${session.currentTool.name} · ${session.currentTool.inputPreview}`
    : session.currentTool.name;
  if (session.phase === 'responding') return t('sessions.responding');
  if (session.phase === 'editing') return t('sessions.editing');
  if (session.status === 'waiting') return t('sessions.waiting');
  return session.toolCallsSinceLastMessage > 0 ? t('sessions.thinkingTools', { count: session.toolCallsSinceLastMessage }) : t('sessions.thinking');
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

function SubAgents({ agents, locale }: { agents: ControlPlaneAiSessionSummary['subAgents']; locale: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
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
        <Text style={[styles.subAgentTitle, { color: colors.text }]}>{t('sessions.subAgents', { count: agents.length, action: expanded ? t('common.hide') : t('common.show') })}</Text>
        <SystemIcon android={expanded ? 'expand_less' : 'expand_more'} color={colors.textMuted} ios={expanded ? 'chevron.up' : 'chevron.down'} size={14} />
      </Pressable>
      {expanded ? agents.slice(0, 50).map((agent) => (
        <View key={agent.threadId} style={[styles.subAgent, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
          <View style={styles.subAgentNameRow}>
            <View style={[styles.statusDot, { backgroundColor: ['running', 'pending-init'].includes(agent.status) ? colors.primary : colors.textMuted }]} />
            <Text numberOfLines={1} style={[styles.subAgentName, { color: colors.text }]}>{agent.path || agent.threadId}</Text>
          </View>
          <Text style={[styles.meta, { color: colors.textMuted }]}>{agent.status} · {agent.activity || t('sessions.activityUnknown')} · {new Date(agent.updatedAt).toLocaleString(locale)}</Text>
          <Text style={[styles.muted, { color: colors.textMuted }]}>{agent.message || t('sessions.noAgentMessage')}</Text>
        </View>
      )) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { paddingHorizontal: 16, paddingBottom: 28, paddingTop: 12 },
  empty: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 17, fontWeight: '700' },
  emptyText: { maxWidth: 260, textAlign: 'center' },
  footer: { gap: 18, marginTop: 18 },
  header: { gap: 12, marginBottom: 20 },
  itemSeparator: { height: 18 },
  modePicker: { alignItems: 'center' },
  sessionBar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 36 },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  turnNavigator: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  turnButton: { alignItems: 'center', height: 32, justifyContent: 'center', width: 32 },
  turnButtonDisabled: { opacity: 0.3 },
  turnIndex: { fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '600', lineHeight: 18, minWidth: 44, textAlign: 'center' },
  statusDot: { borderRadius: 4, height: 8, width: 8 },
  meta: { fontSize: 13, lineHeight: 18, textTransform: 'capitalize' },
  muted: { fontSize: 13, lineHeight: 19 },
  tool: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 32, paddingHorizontal: 2 },
  toolBody: { flex: 1, gap: 3 },
  toolText: { flex: 1 },
  toolTitle: { fontSize: 14, fontWeight: '500', lineHeight: 20 },
  conversationEmpty: { alignItems: 'center', paddingVertical: 32 },
  avatar: { alignItems: 'center', borderRadius: 10, height: 28, justifyContent: 'center', width: 28 },
  promptBlock: { alignSelf: 'flex-end', borderRadius: 18, borderTopRightRadius: 6, maxWidth: '90%', paddingHorizontal: 14, paddingVertical: 12 },
  responseBlock: { alignSelf: 'stretch', paddingHorizontal: 2, paddingVertical: 4 },
  conversationUser: { alignSelf: 'flex-end', borderRadius: 18, borderTopRightRadius: 6, maxWidth: '90%', paddingHorizontal: 14, paddingVertical: 12 },
  conversationResponse: { alignSelf: 'flex-start', maxWidth: '98%', paddingHorizontal: 2, paddingVertical: 4 },
  errorBlock: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 8, padding: 12 },
  errorText: { flex: 1, gap: 6 },
  role: { fontSize: 13, fontWeight: '600', lineHeight: 18, textTransform: 'capitalize' },
  subAgents: { borderTopWidth: StyleSheet.hairlineWidth, gap: 12, marginTop: 8, paddingTop: 16 },
  subAgentHeader: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 44 },
  subAgentTitle: { flex: 1, fontSize: 16, fontWeight: '700', lineHeight: 22 },
  subAgent: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 12 },
  subAgentNameRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  subAgentName: { flex: 1, fontSize: 14, fontWeight: '600', lineHeight: 20 },
});
