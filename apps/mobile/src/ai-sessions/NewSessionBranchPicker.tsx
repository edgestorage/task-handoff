import { useMemo, useState, type ReactElement } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { RepositoryAiSessionWorkspaceBranch } from '@task-handoff/protocol/repository';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';

type BranchFolder = { children: BranchNode[]; id: string; kind: 'folder'; label: string };
type BranchLeaf = { branch: RepositoryAiSessionWorkspaceBranch; id: string; kind: 'branch'; label: string };
type BranchNode = BranchFolder | BranchLeaf;
type VisibleBranchNode =
  | { count: number; depth: number; expanded: boolean; id: string; kind: 'folder'; label: string }
  | { branch: RepositoryAiSessionWorkspaceBranch; depth: number; id: string; kind: 'branch'; label: string };

export function NewSessionBranchPicker(props: {
  branches: RepositoryAiSessionWorkspaceBranch[];
  disabled?: boolean;
  mode: 'current-folder' | 'worktree';
  selectedValue: string;
  title: string;
  children(onPress?: () => void): ReactElement;
  onSelect(value: string): void;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const selectable = useMemo(() => props.branches.filter((branch) => (
    props.mode === 'worktree' ? branch.worktreeSelectable : branch.currentFolderSelectable
  )), [props.branches, props.mode]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? props.branches.filter((branch) => branch.name.toLocaleLowerCase().includes(normalized)) : props.branches;
  }, [props.branches, query]);
  const visible = useMemo(() => flattenBranchTree(buildBranchTree(filtered), collapsedFolders, Boolean(query.trim())), [collapsedFolders, filtered, query]);
  const show = props.disabled || !selectable.length ? undefined : () => setOpen(true);

  const select = (branch: RepositoryAiSessionWorkspaceBranch) => {
    const branchSelectable = props.mode === 'worktree' ? branch.worktreeSelectable : branch.currentFolderSelectable;
    if (!branchSelectable) return;
    setOpen(false);
    setQuery('');
    if (props.mode === 'current-folder' && !branch.current) {
      Alert.alert(
        t('sessions.switchBranchTitle'),
        t('sessions.switchBranchDescription', { branch: branch.name }),
        [
          { style: 'cancel', text: t('common.cancel') },
          { onPress: () => props.onSelect(branch.name), text: t('sessions.confirmBranchSwitch') },
        ],
      );
      return;
    }
    props.onSelect(branch.name);
  };
  const toggleFolder = (id: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return <>
    {props.children(show)}
    <Modal animationType="fade" onRequestClose={() => setOpen(false)} transparent visible={open}>
      <Pressable onPress={() => setOpen(false)} style={styles.backdrop}>
        <Pressable onPress={(event) => event.stopPropagation()} style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>{props.title}</Text>
            <Pressable accessibilityLabel={t('common.cancel')} accessibilityRole="button" hitSlop={8} onPress={() => setOpen(false)}>
              <SystemIcon android="close" color={colors.textMuted} ios="xmark" size={17} />
            </Pressable>
          </View>
          <View style={[styles.search, { backgroundColor: colors.surfaceMuted }]}>
            <SystemIcon android="search" color={colors.textMuted} ios="magnifyingglass" size={15} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setQuery}
              placeholder={t('sessions.searchBranches')}
              placeholderTextColor={colors.textMuted}
              style={[styles.searchInput, { color: colors.text }]}
              value={query}
            />
          </View>
          <FlatList
            data={visible}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<Text style={[styles.empty, { color: colors.textMuted }]}>{t('sessions.noBranches')}</Text>}
            renderItem={({ item }) => {
              const disabled = item.kind === 'branch' && !(props.mode === 'worktree' ? item.branch.worktreeSelectable : item.branch.currentFolderSelectable);
              return <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled }}
                disabled={disabled}
                onPress={() => item.kind === 'folder' ? toggleFolder(item.id) : select(item.branch)}
                style={({ pressed }) => [styles.row, { paddingLeft: 12 + item.depth * 18 }, disabled && styles.disabled, pressed && { backgroundColor: colors.surfaceMuted }]}
              >
                <View style={styles.toggleSlot}>
                  {item.kind === 'folder' ? <SystemIcon
                    android="chevron_right"
                    color={colors.textMuted}
                    ios="chevron.right"
                    size={9}
                    style={item.expanded ? styles.expanded : undefined}
                  /> : null}
                </View>
                <SystemIcon
                  android={item.kind === 'folder' ? (item.expanded ? 'folder_open' : 'folder') : 'account_tree'}
                  color={item.kind === 'folder' ? colors.textMuted : colors.text}
                  ios={item.kind === 'folder' ? (item.expanded ? 'folder.fill' : 'folder') : 'arrow.triangle.branch'}
                  size={16}
                />
                <Text numberOfLines={1} style={[styles.rowLabel, { color: item.kind === 'folder' ? colors.textMuted : colors.text }]}>{item.label}</Text>
                {item.kind === 'folder' ? <Text style={[styles.meta, { color: colors.textMuted }]}>{item.count}</Text> : null}
                {item.kind === 'branch' && props.mode === 'worktree' && item.branch.worktreeCheckout === 'detached'
                  ? <Text style={[styles.meta, { color: colors.textMuted }]}>{t('sessions.detached')}</Text>
                  : null}
                {item.kind === 'branch' && item.branch.name === props.selectedValue
                  ? <SystemIcon android="check" color={colors.primary} ios="checkmark" size={15} />
                  : null}
              </Pressable>;
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  </>;
}

export function buildBranchTree(branches: RepositoryAiSessionWorkspaceBranch[]): BranchNode[] {
  const root: BranchFolder = { children: [], id: 'branch', kind: 'folder', label: 'branch' };
  for (const branch of branches) {
    const parts = branch.name.split('/').filter(Boolean);
    let parent = root;
    for (const [index, part] of parts.entries()) {
      const id = `branch:${parts.slice(0, index + 1).join('/')}`;
      if (index === parts.length - 1) {
        parent.children.push({ branch, id: `${id}:leaf`, kind: 'branch', label: part });
        continue;
      }
      let folder = parent.children.find((node): node is BranchFolder => node.kind === 'folder' && node.label === part);
      if (!folder) {
        folder = { children: [], id, kind: 'folder', label: part };
        parent.children.push(folder);
      }
      parent = folder;
    }
  }
  return root.children;
}

function flattenBranchTree(nodes: BranchNode[], collapsed: Set<string>, forceExpanded: boolean, depth = 0): VisibleBranchNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'branch') return [{ ...node, depth }];
    const expanded = forceExpanded || !collapsed.has(node.id);
    return [
      { count: countLeaves(node), depth, expanded, id: node.id, kind: 'folder' as const, label: node.label },
      ...(expanded ? flattenBranchTree(node.children, collapsed, forceExpanded, depth + 1) : []),
    ];
  });
}

function countLeaves(folder: BranchFolder): number {
  return folder.children.reduce((count, node) => count + (node.kind === 'branch' ? 1 : countLeaves(node)), 0);
}

const styles = StyleSheet.create({
  backdrop: { alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.48)', flex: 1, justifyContent: 'center', padding: 20 },
  panel: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, maxHeight: '72%', maxWidth: 440, overflow: 'hidden', paddingBottom: 8, width: '100%' },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  title: { fontSize: 17, fontWeight: '700', lineHeight: 22 },
  search: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 8, marginBottom: 8, marginHorizontal: 12, minHeight: 38, paddingHorizontal: 11 },
  searchInput: { flex: 1, fontSize: 14, lineHeight: 20, padding: 0 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 44, paddingRight: 14 },
  toggleSlot: { alignItems: 'center', height: 16, justifyContent: 'center', width: 9 },
  expanded: { transform: [{ rotate: '90deg' }] },
  rowLabel: { flex: 1, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  meta: { fontSize: 12, lineHeight: 17 },
  empty: { fontSize: 14, paddingHorizontal: 16, paddingVertical: 28, textAlign: 'center' },
  disabled: { opacity: 0.42 },
});
