import { Profiler, useMemo, useState, type ProfilerOnRenderCallback } from 'react';
import { ActionSheetIOS, ActivityIndicator, FlatList, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
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
import { sessionActivityText } from './SessionDetail';
import { ToolActivityText } from './ToolActivityText';
import { useI18n, type Translate } from '../i18n';
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
}: {
  state: MobileAiSessionProfileState;
  onOpen?(entry: { instanceId: string; sessionId: string }): void;
  directory?: Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>;
  initialScope?: AiSessionScope;
  onScopeChange?(scope: AiSessionScope): void;
}) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const [scope, setScope] = useState<AiSessionScope>(initialScope ?? { kind: 'all' });
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all');
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const scopeOptions = useMemo(() => sessionScopeOptions(directory, t), [directory, t]);
  const instanceNodeIds = useMemo(() => new Map((directory?.instances ?? []).map((instance) => [instance.id, instance.nodeId])), [directory]);
  const allEntries = useMemo(() => inboxEntries(state.snapshot, scope, instanceNodeIds), [state.snapshot, scope, instanceNodeIds]);
  const entries = useMemo(() => allEntries.filter((entry) => matchesStatusFilter(entry.session, statusFilter)), [allEntries, statusFilter]);
  const activeScope = scopeOptions.find((option) => sameScope(option.scope, scope)) ?? { label: t('sessions.scopeAll'), scope: { kind: 'all' } as const };
  const statusMessage = inboxStatusMessage(state.sync, t);

  return (
    <Profiler id="inbox" onRender={recordInboxRender}>
      <>
      {state.sync.phase === 'loading' && !state.snapshot ? <ActivityIndicator accessibilityLabel={t('sessions.loadingAccessibility')} style={styles.loading} /> : (
        <FlatList
          style={[styles.screen, { backgroundColor: colors.background }]}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.list}
          data={entries}
          keyExtractor={(item) => `${item.instanceId}:${item.session.id}`}
          ListHeaderComponent={<View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('sessions.filterAccessibility', { scope: activeScope.label })} onPress={() => openScopePicker(scopeOptions, scope, setScope, onScopeChange, setScopePickerOpen, t)} style={({ pressed }) => [styles.scopeButton, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.scopeButtonPressed]}>
              <SystemIcon android="filter_list" color={colors.primary} ios="line.3.horizontal.decrease.circle" size={18} />
              <Text numberOfLines={1} style={[styles.scopeButtonText, { color: colors.text }]}>{activeScope.label}</Text>
              <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={12} />
            </Pressable>
            <View accessibilityRole="tablist" style={[styles.statusFilters, { backgroundColor: colors.surfaceMuted }]}>
              {(['all', 'active', 'waiting', 'idle', 'problem'] as const).map((filter) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: statusFilter === filter }} key={filter} onPress={() => setStatusFilter(filter)} style={[styles.statusFilter, statusFilter === filter && { backgroundColor: colors.surface }]}><Text style={[styles.statusFilterText, { color: statusFilter === filter ? colors.text : colors.textMuted }]}>{statusFilterLabel(filter, t)}</Text></Pressable>)}
            </View>
            {statusMessage ? <Text accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.notice, color: colors.noticeText }]}>{statusMessage}</Text> : null}
          </View>}
          ListEmptyComponent={<View style={styles.empty}><Text style={[styles.emptyText, { color: colors.textMuted }]}>{state.sync.phase === 'error' ? t('sessions.loadError') : t('sessions.empty')}</Text></View>}
          renderItem={({ item }) => {
            const error = redactedAiSessionError(item.session);
            const content = inboxCardContent(item.session, Object.values(state.messages).filter((message) => message.instanceId === item.instanceId && message.sessionId === item.session.id), t);
            const approvalPending = isAiSessionApprovalPending(item.session);
            const activityText = sessionActivityText(item.session);
            const workspace = workspaceLabel(item.session.cwd, t);
            const identity = workspace.toLocaleLowerCase() === item.session.agent.toLocaleLowerCase()
              ? item.session.agent
              : `${item.session.agent} · ${workspace}`;
            return (
              <Pressable accessibilityRole="button" onPress={() => onOpen?.({ instanceId: item.instanceId, sessionId: item.session.id })} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
                <View style={styles.row}>
                  <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{identity}</Text>
                  {item.session.unread ? <View accessibilityLabel={t('sessions.unread')} style={styles.unread} /> : null}
                </View>
                <Text numberOfLines={2} style={[styles.promptPreview, { color: colors.text }]}>{markdownPlainText(content.prompt)}</Text>
                <Text numberOfLines={2} style={[styles.responsePreview, { color: colors.textMuted }]}>{markdownPlainText(content.response)}</Text>
                {approvalPending ? <View style={styles.activity}><SystemIcon android="approval" color={colors.noticeText} ios="hand.raised.fill" size={13} /><Text style={[styles.activityText, { color: colors.noticeText }]}>{t('sessions.approvalNeeded')}</Text></View> : activityText ? <View style={styles.activity}><SystemIcon android="auto_awesome" color={colors.textMuted} ios="sparkles" size={13} /><ToolActivityText containerStyle={styles.activityTextContainer} running={item.session.status === 'running'} textStyle={styles.activityText}>{activityText}</ToolActivityText></View> : null}
                <View style={styles.row}>
                  <Text style={[styles.status, { color: colors.textMuted }]}>{item.session.status}</Text>
                  <Text style={[styles.time, { color: colors.textMuted }]}>{content.turnCount ? `${content.turnIndex + 1} / ${content.turnCount} · ` : ''}{formatUpdatedTime(aiSessionLastUserMessageAt(item.session) || item.session.startedAt, locale)}</Text>
                </View>
                {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
              </Pressable>
            );
          }}
          />
      )}
      <ScopePickerModal open={scopePickerOpen} options={scopeOptions} scope={scope} onClose={() => setScopePickerOpen(false)} onSelect={(next) => { setScope(next); onScopeChange?.(next); setScopePickerOpen(false); }} />
      </>
    </Profiler>
  );
}

const recordInboxRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  mobileMetrics.record('render.duration', { screen: 'inbox' }, actualDuration);
};

function formatUpdatedTime(value: string, locale: string) {
  return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function openScopePicker(options: SessionScopeOption[], current: AiSessionScope, setScope: (scope: AiSessionScope) => void, onScopeChange: ((scope: AiSessionScope) => void) | undefined, openModal: (open: boolean) => void, t: Translate) {
  if (Platform.OS !== 'ios') {
    openModal(true);
    return;
  }
  ActionSheetIOS.showActionSheetWithOptions({
    cancelButtonIndex: options.length,
    options: [...options.map((option) => option.label), t('common.cancel')],
    title: t('sessions.showSessions'),
  }, (index) => {
    const selected = options[index];
    if (!selected || sameScope(selected.scope, current)) return;
    setScope(selected.scope);
    onScopeChange?.(selected.scope);
  });
}

function ScopePickerModal({ open, options, scope, onClose, onSelect }: { open: boolean; options: SessionScopeOption[]; scope: AiSessionScope; onClose(): void; onSelect(scope: AiSessionScope): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  if (Platform.OS === 'ios') return null;
  return <Modal animationType="slide" onRequestClose={onClose} transparent visible={open}>
    <Pressable onPress={onClose} style={styles.modalBackdrop}>
      <Pressable style={[styles.scopeSheet, { backgroundColor: colors.surface }]}>
        <Text style={[styles.scopeSheetTitle, { color: colors.text }]}>{t('sessions.showSessions')}</Text>
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
  header: { alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingBottom: 12, paddingTop: 16 },
  notice: { backgroundColor: '#fef3c7', borderRadius: 10, color: '#854d0e', fontSize: 13, lineHeight: 18, padding: 12 },
  loading: { flex: 1 },
  list: { paddingBottom: 112 },
  empty: { alignItems: 'center', justifyContent: 'center', minHeight: 240, padding: 24 },
  emptyText: { color: '#64748b', fontSize: 14 },
  scopeButton: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, maxWidth: '100%', minHeight: 40, paddingHorizontal: 12 }, scopeButtonPressed: { opacity: 0.68 }, scopeButtonText: { flexShrink: 1, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  statusFilters: { borderRadius: 9, flexDirection: 'row', padding: 2, width: '100%' },
  statusFilter: { alignItems: 'center', borderRadius: 7, flex: 1, justifyContent: 'center', minHeight: 36, paddingHorizontal: 4 },
  statusFilterText: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
  card: { backgroundColor: '#ffffff', borderColor: '#e2e8f0', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10, marginBottom: 12, marginHorizontal: 16, padding: 16 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  cardTitle: { color: '#0f172a', flex: 1, fontSize: 16, fontWeight: '700' },
  promptPreview: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  responsePreview: { fontSize: 14, lineHeight: 20 },
  unread: { backgroundColor: '#2563eb', borderRadius: 5, height: 10, width: 10 },
  summary: { color: '#475569', fontSize: 13, lineHeight: 19 },
  meta: { color: '#475569', fontSize: 12, lineHeight: 17, textTransform: 'capitalize' },
  status: { color: '#334155', fontSize: 12, fontWeight: '600', lineHeight: 17, textTransform: 'capitalize' },
  activity: { alignItems: 'center', alignSelf: 'stretch', flexDirection: 'row', gap: 8, minHeight: 24 },
  activityTextContainer: { flexShrink: 1 },
  activityText: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  time: { color: '#64748b', fontSize: 12, lineHeight: 17 },
  error: { color: '#b91c1c', fontSize: 13, lineHeight: 18 },
  modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.35)', flex: 1, justifyContent: 'flex-end' }, scopeSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '75%', paddingBottom: 28, paddingHorizontal: 18, paddingTop: 18 }, scopeSheetTitle: { fontSize: 18, fontWeight: '700', paddingBottom: 10 }, scopeOption: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 48 }, scopeOptionText: { flex: 1, fontSize: 15 },
});
