import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';
import type { ControlPlaneClient, RepositorySessionTarget } from '@task-handoff/control-plane-client';
import type { RepositoryChangeEntry, RepositoryChanges, RepositoryContext } from '@task-handoff/protocol/repository';

import { useAdaptiveContentLayout } from '../components/adaptive-layout';
import { Icon, type IconName } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n, type Translate } from '../i18n';
import { RepositoryChangeDiffBody, RepositoryChangeDiffHeader } from './RepositoryChangeDiffCard';
import { buildReviewTree, compareReviewEntries, flattenReviewTree, matchesReviewScope, reviewChangeKey, scopeBadge, type ReviewScope, type ReviewTreeNode } from './repositoryChangePresentation';
import { expandGap, hasExpandedContext, type ContextControl, type GapExpansion, type RepositoryDiffViewMode } from './repositoryDiffPresentation';
import { repositoryFailureCopy, repositoryFailureKind } from './repositoryError';

const changesViewabilityConfig = { itemVisiblePercentThreshold: 10, minimumViewTime: 80 };
const emptyExpandedGaps: ReadonlyMap<string, GapExpansion> = new Map();

type ReviewSection = {
  changeKey: string;
  data: RepositoryChangeEntry[];
  entry: RepositoryChangeEntry;
};

export function RepositoryChangesReview({ active, changes, client, context, failure, onOpenFile, onOpenFiles, onRefresh, ready, target }: {
  active: boolean;
  changes?: RepositoryChanges;
  client?: ControlPlaneClient;
  context?: RepositoryContext;
  failure?: unknown;
  onOpenFile(path: string): void;
  onOpenFiles(): void;
  onRefresh(): void;
  ready: boolean;
  target: RepositorySessionTarget;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [scope, setScope] = useState<ReviewScope>('all');
  const [filesOpen, setFilesOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(new Set());
  const [activeChangeKey, setActiveChangeKey] = useState<string>();
  const [expandedGapsByChange, setExpandedGapsByChange] = useState<ReadonlyMap<string, ReadonlyMap<string, GapExpansion>>>(new Map());
  const [viewMode, setViewMode] = useState<RepositoryDiffViewMode>('unified');
  const [width, setWidth] = useState(0);
  const list = useRef<SectionList<RepositoryChangeEntry, ReviewSection>>(null);
  const entries = useMemo(() => changes?.entries || [], [changes?.entries]);
  const filteredEntries = useMemo(() => entries
    .filter((entry) => matchesReviewScope(entry, scope))
    .sort(compareReviewEntries), [entries, scope]);
  const pickedEntries = useMemo(() => filteredEntries
    .filter((entry) => !filter.trim() || entry.path.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())), [filter, filteredEntries]);
  const pickedFileCount = useMemo(() => new Set(pickedEntries.map((entry) => entry.path)).size, [pickedEntries]);
  const treeRows = useMemo(() => flattenReviewTree(buildReviewTree(pickedEntries), collapsedDirectories, Boolean(filter.trim())), [collapsedDirectories, filter, pickedEntries]);
  const sections = useMemo<ReviewSection[]>(() => filteredEntries.map((entry) => ({
    changeKey: reviewChangeKey(entry),
    data: [entry],
    entry,
  })), [filteredEntries]);
  const logicalFileCount = useMemo(() => new Set(entries.map((entry) => entry.path)).size, [entries]);
  const compact = width > 0 && width <= 720;
  const narrow = width > 0 && width <= 560;
  const splitAvailable = width >= 900;
  const effectiveViewMode = splitAvailable ? viewMode : 'unified';
  const summary = changes?.summary;
  const statusCopy = failure ? repositoryFailureCopy(repositoryFailureKind(failure), t) : undefined;
  const subtitle = repositorySubtitle(context, t);
  const scopeOptions = useMemo(() => [
    { count: entries.length, label: t('sessionResources.scope.all'), value: 'all' as const },
    { count: (summary?.unstaged || 0) + (summary?.untracked || 0), label: t('sessionResources.scope.working'), value: 'working' as const },
    { count: summary?.staged || 0, label: t('sessionResources.scope.staged'), value: 'staged' as const },
    { count: summary?.conflicts || 0, label: t('sessionResources.scope.conflicts'), value: 'conflict' as const },
  ], [entries.length, summary, t]);

  const onRootLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setWidth(nextWidth);
    if (nextWidth < 900) setViewMode((current) => current === 'split' ? 'unified' : current);
  }, []);

  const toggleCollapsed = useCallback((entry: RepositoryChangeEntry) => {
    const key = reviewChangeKey(entry);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const selectFile = useCallback((entry: RepositoryChangeEntry) => {
    setFilesOpen(false);
    setActiveChangeKey(reviewChangeKey(entry));
    const index = filteredEntries.findIndex((candidate) => reviewChangeKey(candidate) === reviewChangeKey(entry));
    if (index >= 0) list.current?.scrollToLocation({ animated: true, itemIndex: 0, sectionIndex: index, viewPosition: 0 });
  }, [filteredEntries]);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: readonly { isViewable?: boolean; item?: RepositoryChangeEntry }[] }) => {
    const visible = viewableItems.find((candidate) => candidate.isViewable && candidate.item);
    if (visible?.item) setActiveChangeKey(reviewChangeKey(visible.item));
  }, []);
  const toggleDirectory = useCallback((path: string) => setCollapsedDirectories((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  }), []);
  const expandContext = useCallback((entry: RepositoryChangeEntry, control: ContextControl) => {
    const contextKey = expandedChangeKey(entry);
    setExpandedGapsByChange((current) => {
      const next = new Map(current);
      next.set(contextKey, expandGap(current.get(contextKey) || emptyExpandedGaps, control.gapId, control.direction, control.lineCount));
      return next;
    });
  }, []);
  const collapseContexts = useCallback((entry: RepositoryChangeEntry) => {
    const contextKey = expandedChangeKey(entry);
    setExpandedGapsByChange((current) => {
      if (!current.has(contextKey)) return current;
      const next = new Map(current);
      next.delete(contextKey);
      return next;
    });
  }, []);

  return <View onLayout={onRootLayout} style={[styles.root, { backgroundColor: colors.background }]} testID="repository-changes-review">
    <View style={[styles.head, compact && styles.headCompact, { backgroundColor: colors.surface, borderBottomColor: colors.workbenchCardBorder }]}>
      <View style={styles.headTitleRow}>
        <Icon color={colors.primary} name="git-compare-outline" size={compact ? 16 : 18} />
        <View style={styles.headCopy}>
          <View style={styles.titleLine}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('sessionResources.changes')}</Text>
            <Text numberOfLines={1} style={[styles.repositorySubtitle, { color: colors.textMuted }]}>{subtitle}</Text>
          </View>
        </View>
        <Text numberOfLines={1} style={[styles.summaryStrong, { color: colors.text }]}>{t('sessionResources.changedFileCount', { count: logicalFileCount })}</Text>
        <Pressable accessibilityLabel={t('sessionResources.diff.openFiles')} accessibilityRole="button" onPress={onOpenFiles} style={({ pressed }) => [styles.headAction, compact && styles.headActionCompact, { backgroundColor: colors.surfaceInset }, pressed && styles.pressed]}>
          <Icon color={colors.textMuted} name="folder-open-outline" size={compact ? 14 : 16} />
        </Pressable>
        <Pressable accessibilityLabel={t('sessionResources.refresh')} accessibilityRole="button" disabled={!ready} onPress={onRefresh} style={({ pressed }) => [styles.headAction, compact && styles.headActionCompact, { backgroundColor: colors.surfaceInset }, !ready && styles.disabled, pressed && styles.pressed]}>
          <Icon color={ready ? colors.primary : colors.textMuted} name="refresh" size={compact ? 14 : 16} />
        </Pressable>
      </View>
      {!compact ? <View style={styles.summaryRow}>
        <Text style={[styles.summary, { color: colors.textMuted }]}>{summary
          ? t('sessionResources.changeSummary', { conflicts: summary.conflicts, staged: summary.staged, working: summary.unstaged + summary.untracked })
          : t('sessionResources.noSnapshot')}</Text>
      </View> : null}
    </View>

    <View style={[styles.toolbar, { backgroundColor: colors.surfaceRaised, borderBottomColor: colors.workbenchCardBorder }]}>
      <Pressable accessibilityLabel={t('sessionResources.changedFiles')} accessibilityRole="button" onPress={() => setFilesOpen(true)} style={({ pressed }) => [styles.filesButton, { backgroundColor: colors.surfaceInset, borderColor: colors.workbenchCardBorder }, pressed && styles.pressed]}>
        <Icon color={colors.textMuted} name="list-outline" size={15} />
        <Text style={[styles.filesButtonText, { color: colors.textMuted }]}>{t('sessionResources.files')}</Text>
        <View style={[styles.countBadge, { backgroundColor: colors.background }]}><Text style={[styles.countText, { color: colors.text }]}>{logicalFileCount}</Text></View>
      </Pressable>
      <ScrollView contentContainerStyle={styles.scopeContent} horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} style={styles.scopes}>
        {scopeOptions.map((option) => {
          const selected = scope === option.value;
          return <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => setScope(option.value)}
            style={({ pressed }) => [styles.scopeButton, selected && { backgroundColor: colors.surfaceHover }, pressed && styles.pressed]}
            testID={`repository-scope-${option.value}`}
          >
            <Text style={[styles.scopeText, { color: selected ? colors.text : colors.textMuted }]}>{option.label}</Text>
            {!narrow ? <View style={[styles.scopeCount, { backgroundColor: colors.background }]}><Text style={[styles.scopeCountText, { color: colors.textMuted }]}>{option.count}</Text></View> : null}
          </Pressable>;
        })}
      </ScrollView>
      {splitAvailable ? <View accessibilityLabel={t('sessionResources.diff.layout')} accessibilityRole="radiogroup" style={[styles.viewToggle, { backgroundColor: colors.surfaceInset, borderColor: colors.workbenchCardBorder }]} testID="repository-view-layout">
        <Pressable
          accessibilityLabel={t('sessionResources.diff.showUnified')}
          accessibilityRole="radio"
          accessibilityState={{ checked: viewMode === 'unified' }}
          onPress={() => setViewMode('unified')}
          style={({ pressed }) => [styles.viewOption, viewMode === 'unified' && { backgroundColor: colors.surface }, pressed && styles.pressed]}
          testID="repository-view-unified"
        ><Icon color={viewMode === 'unified' ? colors.text : colors.textMuted} name="reorder-three-outline" size={15} /></Pressable>
        <Pressable
          accessibilityLabel={t('sessionResources.diff.showSplit')}
          accessibilityRole="radio"
          accessibilityState={{ checked: viewMode === 'split' }}
          onPress={() => setViewMode('split')}
          style={({ pressed }) => [styles.viewOption, viewMode === 'split' && { backgroundColor: colors.surface }, pressed && styles.pressed]}
          testID="repository-view-split"
        ><Icon color={viewMode === 'split' ? colors.text : colors.textMuted} name="albums-outline" size={15} /></Pressable>
      </View> : null}
    </View>

    {!ready ? <StatusState colors={colors} detail={t('sessionResources.unavailable')} icon="cloud-offline-outline" title={t('sessionResources.errorOfflineTitle')} />
      : statusCopy ? <StatusState colors={colors} detail={statusCopy.detail} icon={statusCopy.icon} onRetry={onRefresh} retryLabel={t('common.retry')} title={statusCopy.title} />
        : !changes ? <View style={styles.loading}><ActivityIndicator color={colors.textMuted} /><Text style={[styles.loadingText, { color: colors.textMuted }]}>{t('sessionResources.reviewLoading')}</Text></View>
          : <SectionList
            contentContainerStyle={[styles.listContent, !filteredEntries.length && styles.listContentEmpty]}
            extraData={{ active, collapsed, expandedGapsByChange, viewMode: effectiveViewMode }}
            initialNumToRender={3}
            keyboardShouldPersistTaps="handled"
            keyExtractor={reviewChangeKey}
            ListEmptyComponent={<View style={styles.empty}><Icon color={colors.textMuted} name="checkmark-circle-outline" size={30} /><Text style={[styles.emptyTitle, { color: colors.text }]}>{t('sessionResources.reviewEmptyTitle')}</Text><Text style={[styles.emptyDetail, { color: colors.textMuted }]}>{t('sessionResources.reviewEmptyDetail')}</Text></View>}
            onScrollToIndexFailed={({ averageItemLength, index }) => list.current?.getScrollResponder()?.scrollTo({ animated: true, y: Math.max(0, averageItemLength * index) })}
            ref={list}
            refreshControl={<RefreshControl onRefresh={onRefresh} refreshing={false} tintColor={colors.textMuted} />}
            renderItem={({ section }) => collapsed.has(section.changeKey) ? null : <RepositoryChangeDiffBody
              active={active}
              client={client}
              entry={section.entry}
              expandedGaps={expandedGapsByChange.get(expandedChangeKey(section.entry)) || emptyExpandedGaps}
              onExpandContext={(control) => expandContext(section.entry, control)}
              target={target}
              viewMode={effectiveViewMode}
            />}
            renderSectionHeader={({ section }) => <RepositoryChangeDiffHeader
              collapsed={collapsed.has(section.changeKey)}
              entry={section.entry}
              hasExpandedContext={hasExpandedContext(expandedGapsByChange.get(expandedChangeKey(section.entry)) || emptyExpandedGaps)}
              onCollapseContexts={() => collapseContexts(section.entry)}
              onOpenFile={onOpenFile}
              onToggle={() => toggleCollapsed(section.entry)}
            />}
            sections={sections}
            stickySectionHeadersEnabled
            onViewableItemsChanged={onViewableItemsChanged}
            testID="repository-changes-list"
            viewabilityConfig={changesViewabilityConfig}
            windowSize={5}
          />}

    <FilesPicker
      colors={colors}
      activeChangeKey={activeChangeKey}
      collapsedDirectories={collapsedDirectories}
      fileCount={pickedFileCount}
      nodes={treeRows}
      filter={filter}
      onDirectoryPress={toggleDirectory}
      onClose={() => setFilesOpen(false)}
      onFilterChange={setFilter}
      onSelect={selectFile}
      open={filesOpen}
    />
  </View>;
}

function FilesPicker({ activeChangeKey, collapsedDirectories, colors, fileCount, filter, nodes, onClose, onDirectoryPress, onFilterChange, onSelect, open }: {
  activeChangeKey?: string;
  collapsedDirectories: ReadonlySet<string>;
  colors: ReturnType<typeof useMobileTheme>['colors'];
  fileCount: number;
  filter: string;
  onClose(): void;
  onDirectoryPress(path: string): void;
  onFilterChange(value: string): void;
  onSelect(entry: RepositoryChangeEntry): void;
  nodes: ReviewTreeNode[];
  open: boolean;
}) {
  const { t } = useI18n();
  const adaptive = useAdaptiveContentLayout();
  if (!open) return null;
  return <Modal animationType="fade" onRequestClose={onClose} transparent visible>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
      <Pressable accessibilityLabel={t('common.cancel')} onPress={onClose} style={styles.modalBackdrop} />
      <View style={[styles.modalColumn, adaptive.contentStyle]}>
        <View accessibilityViewIsModal style={[styles.modal, { backgroundColor: colors.surface }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.workbenchCardBorder }]}>
            <View style={styles.modalTitleCopy}><Text accessibilityRole="header" style={[styles.modalTitle, { color: colors.text }]}>{t('sessionResources.changedFiles')}</Text><Text style={[styles.modalSubtitle, { color: colors.textMuted }]}>{t('sessionResources.changedFileCount', { count: fileCount })}</Text></View>
            <Pressable accessibilityLabel={t('common.cancel')} accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.modalClose, { backgroundColor: colors.surfaceInset }, pressed && styles.pressed]}><Icon color={colors.textMuted} name="close" size={17} /></Pressable>
          </View>
          <View style={[styles.search, { backgroundColor: colors.surfaceInset, borderColor: colors.workbenchCardBorder }]}>
            <Icon color={colors.textMuted} name="search-outline" size={15} />
            <TextInput accessibilityLabel={t('sessionResources.filterChanges')} autoCapitalize="none" autoCorrect={false} onChangeText={onFilterChange} placeholder={t('sessionResources.filterChanges')} placeholderTextColor={colors.textMuted} style={[styles.searchInput, { color: colors.text }]} value={filter} />
          </View>
          <FlatList
            data={nodes}
            keyExtractor={(node) => node.key}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<Text style={[styles.noMatches, { color: colors.textMuted }]}>{t('sessionResources.noMatchingChanges')}</Text>}
            renderItem={({ item }) => item.kind === 'directory'
              ? <Pressable
                accessibilityLabel={`${item.name}, ${item.fileCount}`}
                accessibilityRole="button"
                accessibilityState={{ expanded: Boolean(filter.trim()) || !collapsedDirectories.has(item.path) }}
                key={item.key}
                onPress={() => onDirectoryPress(item.path)}
                style={({ pressed }) => [styles.treeRow, { paddingLeft: 6 + item.depth * 14 }, pressed && styles.pressed]}
                testID={`repository-change-tree-${item.key}`}
              >
                <View style={styles.treeChevron}><Icon color={colors.textMuted} name={Boolean(filter.trim()) || !collapsedDirectories.has(item.path) ? 'chevron-down' : 'chevron-forward'} size={13} /></View>
                <Icon color={colors.primary} name="folder-outline" size={15} />
                <Text numberOfLines={1} style={[styles.treeName, { color: colors.text }]}>{item.name}</Text>
                <Text style={[styles.treeCount, { color: colors.textMuted }]}>{item.fileCount}</Text>
              </Pressable>
              : <Pressable
                accessibilityLabel={item.path}
                accessibilityRole="button"
                accessibilityState={{ selected: item.entries.some((entry) => reviewChangeKey(entry) === activeChangeKey) }}
                key={item.key}
                onPress={() => item.entries[0] && onSelect(item.entries[0])}
                style={({ pressed }) => [styles.treeRow, { paddingLeft: 6 + item.depth * 14 }, item.entries.some((entry) => reviewChangeKey(entry) === activeChangeKey) && { backgroundColor: colors.workbenchSelectionBackground }, pressed && styles.pressed]}
                testID={`repository-change-tree-${item.key}`}
              >
                <View style={styles.treeChevron} />
                <Icon color={colors.primary} name="git-compare-outline" size={15} />
                <Text numberOfLines={1} style={[styles.treeName, { color: colors.text }]}>{item.name}</Text>
                <View style={styles.treeBadges}>{item.entries.map((entry) => <View key={reviewChangeKey(entry)} style={[styles.scopeBadge, { backgroundColor: scopeBadgeBackground(entry.scope, colors) }]}><Text style={[styles.scopeBadgeText, { color: scopeBadgeColor(entry.scope, colors) }]}>{scopeBadge(entry.scope)}</Text></View>)}</View>
              </Pressable>}
            style={styles.fileList}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

function scopeBadgeBackground(scope: RepositoryChangeEntry['scope'], colors: ReturnType<typeof useMobileTheme>['colors']) {
  if (scope === 'conflict') return colors.errorSoft;
  if (scope === 'staged') return colors.sessionActiveSoft;
  return colors.sessionWaitingSoft;
}

function scopeBadgeColor(scope: RepositoryChangeEntry['scope'], colors: ReturnType<typeof useMobileTheme>['colors']) {
  if (scope === 'conflict') return colors.error;
  if (scope === 'staged') return colors.sessionActive;
  return colors.sessionWaiting;
}

function StatusState({ colors, detail, icon, onRetry, retryLabel, title }: {
  colors: ReturnType<typeof useMobileTheme>['colors'];
  detail: string;
  icon: IconName;
  onRetry?(): void;
  retryLabel?: string;
  title: string;
}) {
  return <View style={styles.empty}>
    <View style={[styles.statusIcon, { backgroundColor: colors.surfaceInset }]}><Icon color={colors.textMuted} name={icon} size={24} /></View>
    <Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
    <Text style={[styles.emptyDetail, { color: colors.textMuted }]}>{detail}</Text>
    {onRetry && retryLabel ? <Pressable accessibilityRole="button" onPress={onRetry} style={({ pressed }) => [styles.retry, { backgroundColor: colors.primaryButton }, pressed && styles.pressed]}><Text style={styles.retryText}>{retryLabel}</Text></Pressable> : null}
  </View>;
}

function repositorySubtitle(context: RepositoryContext | undefined, t: Translate) {
  if (!context) return '';
  const name = context.displayName || t('sessionResources.repository');
  const branch = context.head?.state === 'branch' ? context.head.branch
    : context.head?.state === 'detached' ? t('sessions.detachedAt', { commit: context.head.oid?.slice(0, 8) || '' })
      : context.head?.state === 'unborn' ? t('repository.worktrees.unbornBranch') : '';
  const cwd = context.cwdRelativePath ? t('sessionResources.repositoryCwd', { path: context.cwdRelativePath }) : '';
  return [name, branch, cwd].filter(Boolean).join(' · ');
}

function expandedChangeKey(entry: RepositoryChangeEntry) {
  return `${reviewChangeKey(entry)}\0${entry.version}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0 },
  head: { borderBottomWidth: StyleSheet.hairlineWidth, gap: 3, paddingHorizontal: 12, paddingVertical: 9 },
  headCompact: { minHeight: 40, paddingHorizontal: 8, paddingVertical: 5 },
  headTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  headCopy: { flex: 1, gap: 1, minWidth: 0 },
  titleLine: { alignItems: 'baseline', flexDirection: 'row', gap: 6, minWidth: 0 },
  title: { flexShrink: 0, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  repositorySubtitle: { flexShrink: 1, fontSize: 12, lineHeight: 16 },
  headAction: { alignItems: 'center', borderRadius: 8, height: 30, justifyContent: 'center', width: 32 },
  headActionCompact: { height: 28, width: 28 },
  summaryRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 26 },
  summaryStrong: { fontSize: 12, fontWeight: '600', lineHeight: 17 },
  summary: { flexShrink: 1, fontSize: 12, lineHeight: 17 },
  toolbar: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 6, minHeight: 42, paddingHorizontal: 8, paddingVertical: 5 },
  filesButton: { alignItems: 'center', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 5, height: 29, paddingHorizontal: 7 },
  filesButtonText: { fontSize: 12, lineHeight: 17 },
  countBadge: { alignItems: 'center', borderRadius: 999, minWidth: 17, paddingHorizontal: 5, paddingVertical: 1 },
  countText: { fontSize: 10, fontWeight: '500', lineHeight: 13 },
  scopes: { flex: 1, minWidth: 0 },
  scopeContent: { alignItems: 'center', gap: 2 },
  scopeButton: { alignItems: 'center', borderRadius: 6, flexDirection: 'row', gap: 4, height: 29, paddingHorizontal: 7 },
  scopeText: { fontSize: 12, lineHeight: 17 },
  scopeCount: { alignItems: 'center', borderRadius: 999, minWidth: 16, paddingHorizontal: 4, paddingVertical: 1 },
  scopeCountText: { fontSize: 10, lineHeight: 13 },
  viewToggle: { alignItems: 'center', borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 2, padding: 2 },
  viewOption: { alignItems: 'center', borderRadius: 4, height: 24, justifyContent: 'center', width: 27 },
  listContent: { flexGrow: 1, paddingBottom: 12 },
  listContentEmpty: { justifyContent: 'center' },
  loading: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 8, justifyContent: 'center', padding: 24 },
  loadingText: { fontSize: 12, lineHeight: 17 },
  empty: { alignItems: 'center', flex: 1, gap: 7, justifyContent: 'center', minHeight: 220, padding: 24 },
  statusIcon: { alignItems: 'center', borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },
  emptyTitle: { fontSize: 14, fontWeight: '500', lineHeight: 20, textAlign: 'center' },
  emptyDetail: { fontSize: 12, lineHeight: 18, maxWidth: 320, textAlign: 'center' },
  retry: { alignItems: 'center', borderRadius: 9, justifyContent: 'center', marginTop: 4, minHeight: 38, minWidth: 92, paddingHorizontal: 14 },
  retryText: { color: '#ffffff', fontSize: 13, fontWeight: '500', lineHeight: 18 },
  modalOverlay: { flex: 1 },
  modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.35)', bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  modalColumn: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 20 },
  modal: { borderRadius: 14, maxHeight: 620, maxWidth: 520, overflow: 'hidden', width: '100%' },
  modalHeader: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', paddingHorizontal: 15, paddingVertical: 11 },
  modalTitleCopy: { flex: 1, gap: 1 },
  modalTitle: { fontSize: 16, fontWeight: '600', lineHeight: 21 },
  modalSubtitle: { fontSize: 12, lineHeight: 16 },
  modalClose: { alignItems: 'center', borderRadius: 8, height: 30, justifyContent: 'center', width: 30 },
  search: { alignItems: 'center', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 6, margin: 12, minHeight: 38, paddingHorizontal: 10 },
  searchInput: { flex: 1, fontSize: 14, minHeight: 36, paddingVertical: 7 },
  fileList: { flexGrow: 0, maxHeight: 500 },
  treeRow: { alignItems: 'center', borderRadius: 4, flexDirection: 'row', gap: 6, minHeight: 34, paddingRight: 8, paddingVertical: 4 },
  treeChevron: { alignItems: 'center', height: 16, justifyContent: 'center', width: 14 },
  treeName: { flex: 1, fontSize: 12, lineHeight: 17 },
  treeCount: { fontSize: 12, lineHeight: 16 },
  treeBadges: { alignItems: 'center', flexDirection: 'row', gap: 3 },
  scopeBadge: { alignItems: 'center', borderRadius: 5, minWidth: 22, paddingHorizontal: 5, paddingVertical: 2 },
  scopeBadgeText: { fontSize: 11, fontWeight: '500', lineHeight: 15 },
  noMatches: { fontSize: 12, lineHeight: 18, padding: 20, textAlign: 'center' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.6 },
});
