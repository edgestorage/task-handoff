import { Profiler, useMemo, useState, type ProfilerOnRenderCallback } from 'react';
import { ActionSheetIOS, ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  aiSessionLastUserMessageAt,
  isAiSessionApprovalPending,
  redactedAiSessionError,
} from '@task-handoff/control-plane-client';

import type { AiSessionScope, MobileAiSessionProfileState } from './store';
import type { MobileDirectoryProfileState } from '../directories/store';
import { mobileMetrics } from '../observability/mobile-metrics';
import { useMobileTheme } from '../components/theme';
import { SystemIcon } from '../components/SystemIcon';
import { markdownPlainText } from '../components/SafeMarkdown';
import { ScreenFlatList } from '../components/ScreenFlatList';
import { sessionActivityText } from './SessionDetail';
import {
  inboxCardContent,
  inboxEntries,
  inboxStatusMessage,
  matchesStatusFilter,
  sameScope,
  sessionScopeOptions,
  statusFilterLabel,
  workspaceLabel,
  type SessionScopeOption,
  type SessionStatusFilter,
} from './InboxModel';

export { inboxCardContent, inboxEntries, sessionScopeOptions } from './InboxModel';

export function AiSessionInbox({
  state,
  onOpen,
  directory,
  initialScope,
  onScopeChange,
  onCreate,
}: {
  state: MobileAiSessionProfileState;
  onOpen?(entry: { instanceId: string; sessionId: string }): void;
  directory?: Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>;
  initialScope?: AiSessionScope;
  onScopeChange?(scope: AiSessionScope): void;
  onCreate?(): void;
}) {
  const { colors } = useMobileTheme();
  const [scope, setScope] = useState<AiSessionScope>(initialScope ?? { kind: 'all' });
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all');
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const scopeOptions = useMemo(() => sessionScopeOptions(directory), [directory]);
  const instanceNodeIds = useMemo(() => new Map((directory?.instances ?? []).map((instance) => [instance.id, instance.nodeId])), [directory]);
  const allEntries = useMemo(() => inboxEntries(state.snapshot, scope, instanceNodeIds), [state.snapshot, scope, instanceNodeIds]);
  const entries = useMemo(() => allEntries.filter((entry) => matchesStatusFilter(entry.session, statusFilter)), [allEntries, statusFilter]);
  const activeScope = scopeOptions.find((option) => sameScope(option.scope, scope)) ?? { label: 'All Sessions', scope: { kind: 'all' } as const };
  const statusMessage = inboxStatusMessage(state.sync);

  return (
    <Profiler id="inbox" onRender={recordInboxRender}>
      <SafeAreaView edges={['top']} style={[styles.screen, { backgroundColor: colors.background }]}> 
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>AI Sessions</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="New AI Session" hitSlop={10} onPress={onCreate} style={({ pressed }) => [styles.createButton, pressed && styles.scopeButtonPressed]}>
            <SystemIcon android="add" color={colors.primary} ios="plus" size={20} />
          </Pressable>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Filter sessions, current scope ${activeScope.label}`} onPress={() => openScopePicker(scopeOptions, scope, setScope, onScopeChange, setScopePickerOpen)} style={({ pressed }) => [styles.scopeButton, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.scopeButtonPressed]}>
          <SystemIcon android="filter_list" color={colors.primary} ios="line.3.horizontal.decrease.circle" size={18} />
          <Text numberOfLines={1} style={[styles.scopeButtonText, { color: colors.text }]}>{activeScope.label}</Text>
          <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={12} />
        </Pressable>
        <View accessibilityRole="tablist" style={[styles.statusFilters, { backgroundColor: colors.surfaceMuted }]}> 
          {(['all', 'active', 'waiting', 'idle', 'problem'] as const).map((filter) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: statusFilter === filter }} key={filter} onPress={() => setStatusFilter(filter)} style={[styles.statusFilter, statusFilter === filter && { backgroundColor: colors.surface }]}><Text style={[styles.statusFilterText, { color: statusFilter === filter ? colors.text : colors.textMuted }]}>{statusFilterLabel(filter)}</Text></Pressable>)}
        </View>
        {statusMessage ? <Text accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.notice, color: colors.noticeText }]}>{statusMessage}</Text> : null}
      </View>
      <ScopePickerModal open={scopePickerOpen} options={scopeOptions} scope={scope} onClose={() => setScopePickerOpen(false)} onSelect={(next) => { setScope(next); onScopeChange?.(next); setScopePickerOpen(false); }} />
      {state.sync.phase === 'loading' && !state.snapshot ? <ActivityIndicator accessibilityLabel="Loading AI Sessions" style={styles.loading} /> : (
        <ScreenFlatList
          contentContainerStyle={entries.length ? styles.list : styles.empty}
          data={entries}
          keyExtractor={(entry) => `${entry.instanceId}:${entry.session.id}`}
          ListEmptyComponent={<Text style={[styles.emptyText, { color: colors.textMuted }]}>{state.sync.phase === 'error' ? 'AI Sessions could not be loaded.' : 'No AI Sessions yet.'}</Text>}
          renderItem={({ item }) => {
            const error = redactedAiSessionError(item.session);
            const content = inboxCardContent(item.session, Object.values(state.messages).filter((message) => message.instanceId === item.instanceId && message.sessionId === item.session.id));
            const approvalPending = isAiSessionApprovalPending(item.session);
            const activityText = sessionActivityText(item.session);
            const workspace = workspaceLabel(item.session.cwd);
            const identity = workspace.toLocaleLowerCase() === item.session.agent.toLocaleLowerCase()
              ? item.session.agent
              : `${item.session.agent} · ${workspace}`;
            return (
              <Pressable accessibilityRole="button" onPress={() => onOpen?.({ instanceId: item.instanceId, sessionId: item.session.id })} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
                <View style={styles.row}>
                  <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{identity}</Text>
                  {item.session.unread ? <View accessibilityLabel="Unread" style={styles.unread} /> : null}
                </View>
                <Text numberOfLines={2} style={[styles.promptPreview, { color: colors.text }]}>{markdownPlainText(content.prompt)}</Text>
                <Text numberOfLines={2} style={[styles.responsePreview, { color: colors.textMuted }]}>{markdownPlainText(content.response)}</Text>
                {approvalPending ? <View style={styles.activity}><SystemIcon android="approval" color={colors.noticeText} ios="hand.raised.fill" size={13} /><Text style={[styles.activityText, { color: colors.noticeText }]}>Approval needed</Text></View> : activityText ? <View style={styles.activity}><SystemIcon android="auto_awesome" color={colors.textMuted} ios="sparkles" size={13} /><Text numberOfLines={1} style={[styles.activityText, { color: colors.textMuted }]}>{activityText}</Text></View> : null}
                <View style={styles.row}>
                  <Text style={[styles.status, { color: colors.textMuted }]}>{item.session.status}</Text>
                  <Text style={[styles.time, { color: colors.textMuted }]}>{content.turnCount ? `${content.turnIndex + 1} / ${content.turnCount} · ` : ''}{formatUpdatedTime(aiSessionLastUserMessageAt(item.session) || item.session.startedAt)}</Text>
                </View>
                {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
              </Pressable>
            );
          }}
        />
      )}
      </SafeAreaView>
    </Profiler>
  );
}

const recordInboxRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  mobileMetrics.record('render.duration', { screen: 'inbox' }, actualDuration);
};

function formatUpdatedTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function openScopePicker(options: SessionScopeOption[], current: AiSessionScope, setScope: (scope: AiSessionScope) => void, onScopeChange: ((scope: AiSessionScope) => void) | undefined, openModal: (open: boolean) => void) {
  if (Platform.OS !== 'ios') {
    openModal(true);
    return;
  }
  ActionSheetIOS.showActionSheetWithOptions({
    cancelButtonIndex: options.length,
    options: [...options.map((option) => option.label), 'Cancel'],
    title: 'Show AI Sessions',
  }, (index) => {
    const selected = options[index];
    if (!selected || sameScope(selected.scope, current)) return;
    setScope(selected.scope);
    onScopeChange?.(selected.scope);
  });
}

function ScopePickerModal({ open, options, scope, onClose, onSelect }: { open: boolean; options: SessionScopeOption[]; scope: AiSessionScope; onClose(): void; onSelect(scope: AiSessionScope): void }) {
  const { colors } = useMobileTheme();
  if (Platform.OS === 'ios') return null;
  return <Modal animationType="slide" onRequestClose={onClose} transparent visible={open}>
    <Pressable onPress={onClose} style={styles.modalBackdrop}>
      <Pressable style={[styles.scopeSheet, { backgroundColor: colors.surface }]}>
        <Text style={[styles.scopeSheetTitle, { color: colors.text }]}>Show AI Sessions</Text>
        {options.map((option) => <Pressable accessibilityRole="button" accessibilityState={{ selected: sameScope(option.scope, scope) }} key={JSON.stringify(option.scope)} onPress={() => onSelect(option.scope)} style={styles.scopeOption}>
          <Text style={[styles.scopeOptionText, { color: colors.text }]}>{option.label}</Text>
          {sameScope(option.scope, scope) ? <SystemIcon android="check" color={colors.primary} ios="checkmark" size={18} /> : null}
        </Pressable>)}
      </Pressable>
    </Pressable>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#f8fafc', flex: 1 },
  header: { alignItems: 'flex-start', gap: 10, paddingHorizontal: 16, paddingBottom: 10, paddingTop: 16 },
  title: { color: '#0f172a', fontSize: 28, fontWeight: '700' },
  titleRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
  createButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
  notice: { backgroundColor: '#fef3c7', borderRadius: 8, color: '#854d0e', fontSize: 12, padding: 10 },
  loading: { flex: 1 },
  list: { gap: 10, padding: 16, paddingBottom: 112, paddingTop: 6 },
  empty: { alignItems: 'center', flexGrow: 1, justifyContent: 'center', padding: 24 },
  emptyText: { color: '#64748b', fontSize: 14 },
  scopeButton: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 7, maxWidth: '100%', minHeight: 38, paddingHorizontal: 10 }, scopeButtonPressed: { opacity: 0.68 }, scopeButtonText: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
  statusFilters: { borderRadius: 9, flexDirection: 'row', padding: 2, width: '100%' },
  statusFilter: { alignItems: 'center', borderRadius: 7, flex: 1, justifyContent: 'center', minHeight: 32, paddingHorizontal: 4 },
  statusFilterText: { fontSize: 12, fontWeight: '600' },
  card: { backgroundColor: '#ffffff', borderColor: '#e2e8f0', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 14 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  cardTitle: { color: '#0f172a', flex: 1, fontSize: 16, fontWeight: '700' },
  promptPreview: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  responsePreview: { fontSize: 14, lineHeight: 19 },
  unread: { backgroundColor: '#2563eb', borderRadius: 5, height: 10, width: 10 },
  summary: { color: '#475569', fontSize: 13, lineHeight: 19 },
  meta: { color: '#475569', fontSize: 12, textTransform: 'capitalize' },
  status: { color: '#334155', fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  activity: { alignItems: 'center', alignSelf: 'stretch', flexDirection: 'row', gap: 6, minHeight: 22 },
  activityText: { flexShrink: 1, fontSize: 12, fontWeight: '500' },
  time: { color: '#64748b', fontSize: 12 },
  error: { color: '#b91c1c', fontSize: 12 },
  modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.35)', flex: 1, justifyContent: 'flex-end' }, scopeSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '75%', paddingBottom: 28, paddingHorizontal: 18, paddingTop: 18 }, scopeSheetTitle: { fontSize: 18, fontWeight: '700', paddingBottom: 10 }, scopeOption: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 48 }, scopeOptionText: { flex: 1, fontSize: 15 },
});
