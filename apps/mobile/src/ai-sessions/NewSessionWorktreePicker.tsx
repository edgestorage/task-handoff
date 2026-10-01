import { useMemo, useState, type ReactElement } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { RepositoryWorktree } from '@task-handoff/protocol/repository';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { repositoryWorktreeCreateBlockers, repositoryWorktreeLabel, repositoryWorktreeMeta, repositoryWorktreeSearchText } from '../repository/worktree-presentation';

export function NewSessionWorktreePicker(props: {
  busy?: boolean;
  disabled?: boolean;
  newWorktreeLabel: string;
  selectedValue: string;
  title: string;
  worktrees: RepositoryWorktree[];
  children(onPress?: () => void): ReactElement;
  onNewWorktree(): void;
  onSelect(worktreeId: string): void;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? props.worktrees.filter((worktree) => repositoryWorktreeSearchText(worktree, t).includes(normalized))
      : props.worktrees;
  }, [props.worktrees, query, t]);
  const show = props.disabled ? undefined : () => setOpen(true);
  const close = () => { setOpen(false); setQuery(''); };
  return <>
    {props.children(show)}
    <Modal animationType="fade" onRequestClose={close} transparent visible={open}>
      <Pressable onPress={close} style={styles.backdrop}>
        <Pressable onPress={(event) => event.stopPropagation()} style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>{props.title}</Text>
            <Pressable accessibilityLabel={t('common.cancel')} accessibilityRole="button" hitSlop={8} onPress={close}>
              <SystemIcon android="close" color={colors.textMuted} ios="xmark" size={17} />
            </Pressable>
          </View>
          <View style={[styles.search, { backgroundColor: colors.surfaceMuted }]}>
            <SystemIcon android="search" color={colors.textMuted} ios="magnifyingglass" size={15} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setQuery}
              placeholder={t('sessions.searchWorktrees')}
              placeholderTextColor={colors.textMuted}
              style={[styles.searchInput, { color: colors.text }]}
              value={query}
            />
          </View>
          <FlatList
            data={visible}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<Text style={[styles.empty, { color: colors.textMuted }]}>{t('sessions.noWorktrees')}</Text>}
            ListFooterComponent={<Pressable accessibilityRole="button" onPress={() => { close(); props.onNewWorktree(); }} style={({ pressed }) => [styles.row, styles.newRow, { borderTopColor: colors.border }, pressed && { backgroundColor: colors.surfaceMuted }]}>
              <SystemIcon android="add" color={colors.primary} ios="plus" size={16} />
              <Text style={[styles.rowLabel, { color: colors.primary }]}>{props.newWorktreeLabel}</Text>
            </Pressable>}
            renderItem={({ item }) => {
              const blockers = repositoryWorktreeCreateBlockers(item, t);
              const disabled = !item.canCreateAiSession || Boolean(props.busy);
              const selected = item.id === props.selectedValue;
              return <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled, selected }}
                disabled={disabled}
                onPress={() => { close(); props.onSelect(item.id); }}
                style={({ pressed }) => [styles.row, disabled && styles.disabled, pressed && { backgroundColor: colors.surfaceMuted }]}
              >
                <SystemIcon android="account_tree" color={colors.text} ios="arrow.triangle.branch" size={16} />
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={[styles.rowLabel, { color: colors.text }]}>{repositoryWorktreeLabel(item, t)}</Text>
                  <Text numberOfLines={1} style={[styles.rowMeta, { color: colors.textMuted }]}>{repositoryWorktreeMeta(item, t)}</Text>
                  {blockers.length ? <Text numberOfLines={1} style={[styles.rowBlocker, { color: colors.error }]}>{blockers.join(' · ')}</Text> : null}
                </View>
                {selected ? <SystemIcon android="check" color={colors.primary} ios="checkmark" size={15} /> : null}
              </Pressable>;
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  backdrop: { alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.48)', flex: 1, justifyContent: 'center', padding: 20 },
  panel: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, maxHeight: '72%', maxWidth: 440, overflow: 'hidden', paddingBottom: 8, width: '100%' },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  title: { fontSize: 17, fontWeight: '700', lineHeight: 22 },
  search: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 8, marginBottom: 8, marginHorizontal: 12, minHeight: 38, paddingHorizontal: 11 },
  searchInput: { flex: 1, fontSize: 14, lineHeight: 20, padding: 0 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 52, paddingHorizontal: 14, paddingVertical: 8 },
  newRow: { borderTopWidth: StyleSheet.hairlineWidth, minHeight: 46 },
  rowCopy: { flex: 1, gap: 2 },
  rowLabel: { flexShrink: 1, fontSize: 14, fontWeight: '500', lineHeight: 20 },
  rowMeta: { fontSize: 12, lineHeight: 17 },
  rowBlocker: { fontSize: 12, lineHeight: 17 },
  empty: { fontSize: 14, paddingHorizontal: 16, paddingVertical: 28, textAlign: 'center' },
  disabled: { opacity: 0.42 },
});
