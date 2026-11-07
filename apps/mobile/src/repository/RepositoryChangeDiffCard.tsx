import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ControlPlaneClient, RepositorySessionTarget } from '@task-handoff/control-plane-client';
import type { RepositoryChangeEntry, RepositoryDiff } from '@task-handoff/protocol/repository';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { RepositoryDiffView } from './RepositoryDiffView';
import { changeStatusMessageKey, reviewChangeKey } from './repositoryChangePresentation';
import { contextLineLimit, type ContextControl, type GapExpansion, type RepositoryDiffViewMode } from './repositoryDiffPresentation';
import { repositoryFailureCopy, repositoryFailureKind } from './repositoryError';

export function RepositoryChangeDiffHeader({ collapsed, entry, hasExpandedContext, onCollapseContexts, onOpenFile, onToggle }: {
  collapsed: boolean;
  entry: RepositoryChangeEntry;
  hasExpandedContext: boolean;
  onCollapseContexts(): void;
  onOpenFile(path: string): void;
  onToggle(): void;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const status = t(changeStatusMessageKey(entry.status));
  const scope = t(`sessionResources.scope.${entry.scope}`);
  const subtitle = useMemo(() => `${scope} · ${status}`, [scope, status]);
  const expanded = !collapsed;

  return <View style={[styles.headerWrap, { backgroundColor: colors.surfaceRaised, borderBottomColor: colors.workbenchCardBorder }]} testID={`repository-change-${reviewChangeKey(entry)}`}>
    <Pressable
      accessibilityLabel={`${entry.path}, ${subtitle}`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={({ pressed }) => [styles.header, pressed && styles.pressed]}
    >
      <View style={styles.chevron}><Icon color={colors.textMuted} name={expanded ? 'chevron-down' : 'chevron-forward'} size={15} /></View>
      <Icon color={colors.primary} name="git-compare-outline" size={16} />
      <View style={styles.titleCopy}>
        <Text numberOfLines={1} style={[styles.path, { color: colors.text }]}>{entry.path}</Text>
        <Text numberOfLines={1} style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text>
      </View>
      {expanded && hasExpandedContext ? <Pressable
        accessibilityLabel={t('sessionResources.diff.collapse')}
        accessibilityRole="button"
        hitSlop={6}
        onPress={(event) => { event.stopPropagation(); onCollapseContexts(); }}
        style={({ pressed }) => [styles.action, { backgroundColor: colors.surfaceInset }, pressed && styles.pressed]}
      ><Icon color={colors.textMuted} name="contract-outline" size={15} /></Pressable> : null}
      <Pressable
        accessibilityLabel={t('sessionResources.diff.openFiles')}
        accessibilityRole="button"
        hitSlop={6}
        onPress={(event) => { event.stopPropagation(); onOpenFile(entry.path); }}
        style={({ pressed }) => [styles.action, { backgroundColor: colors.surfaceInset }, pressed && styles.pressed]}
      ><Icon color={colors.textMuted} name="folder-open-outline" size={15} /></Pressable>
    </Pressable>
  </View>;
}

export function RepositoryChangeDiffBody({ active, client, entry, expandedGaps, onExpandContext, target, viewMode }: {
  active: boolean;
  client?: ControlPlaneClient;
  entry: RepositoryChangeEntry;
  expandedGaps: ReadonlyMap<string, GapExpansion>;
  onExpandContext(control: ContextControl): void;
  target: RepositorySessionTarget;
  viewMode: RepositoryDiffViewMode;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; diff?: RepositoryDiff; error?: unknown }>();
  const contextLines = contextLineLimit(expandedGaps);
  const requestKey = JSON.stringify([entry.path, entry.scope, entry.version, contextLines, retry]);
  const diff = result?.key === requestKey ? result.diff : undefined;
  const error = result?.key === requestKey ? result.error : undefined;

  useEffect(() => {
    if (!active || !client || entry.binary) return;
    const abort = new AbortController();
    void client.repository.diff(target, {
      byteLimit: 128 * 1024,
      contextLines,
      includeContext: true,
      path: entry.path,
      scope: entry.scope,
    }, { signal: abort.signal }).then((next) => {
      if (!abort.signal.aborted) setResult({ diff: next, key: requestKey });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setResult({ error: cause, key: requestKey });
    });
    return () => abort.abort();
  }, [active, client, contextLines, entry.binary, entry.path, entry.scope, requestKey, target]);

  const failure = error ? repositoryFailureCopy(repositoryFailureKind(error), t) : undefined;

  return <View style={[styles.body, { backgroundColor: colors.surface }]} testID={`repository-change-body-${reviewChangeKey(entry)}`}>
    {entry.binary ? <FileState colors={colors} detail={t('sessionResources.diff.binaryHint')} icon="document-outline" title={t('sessionResources.diff.binary')} />
      : failure ? <View style={styles.state}>
        <Icon color={colors.error} name={failure.icon} size={20} />
        <View style={styles.stateCopy}><Text style={[styles.stateTitle, { color: colors.text }]}>{failure.title}</Text><Text style={[styles.stateDetail, { color: colors.textMuted }]}>{failure.detail}</Text></View>
        <Pressable accessibilityRole="button" onPress={() => setRetry((current) => current + 1)} style={({ pressed }) => [styles.retry, { backgroundColor: colors.surfaceInset }, pressed && styles.pressed]}><Text style={[styles.retryText, { color: colors.primary }]}>{t('common.retry')}</Text></Pressable>
      </View>
        : !diff ? <View style={styles.loading}><ActivityIndicator color={colors.textMuted} /><Text style={[styles.loadingText, { color: colors.textMuted }]}>{t('sessionResources.diff.loading')}</Text></View>
          : <>
            {diff.truncated ? <View style={[styles.warning, { backgroundColor: colors.notice }]}><Icon color={colors.noticeText} name="warning-outline" size={14} /><Text style={[styles.warningText, { color: colors.noticeText }]}>{t('sessionResources.diff.truncatedBytes', { count: diff.byteLimit })}</Text></View> : null}
            <RepositoryDiffView colors={colors} diff={diff} expandedGaps={expandedGaps} onExpandContext={onExpandContext} path={entry.path} viewMode={viewMode} />
          </>}
  </View>;
}

function FileState({ colors, detail, icon, title }: {
  colors: ReturnType<typeof useMobileTheme>['colors'];
  detail: string;
  icon: 'document-outline';
  title: string;
}) {
  return <View style={styles.state}>
    <Icon color={colors.textMuted} name={icon} size={22} />
    <View style={styles.stateCopy}><Text style={[styles.stateTitle, { color: colors.text }]}>{title}</Text><Text style={[styles.stateDetail, { color: colors.textMuted }]}>{detail}</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  headerWrap: { borderBottomWidth: StyleSheet.hairlineWidth, elevation: 3, zIndex: 3 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 40, paddingHorizontal: 8, paddingVertical: 5 },
  chevron: { alignItems: 'center', height: 22, justifyContent: 'center', width: 18 },
  titleCopy: { flex: 1, gap: 1, minWidth: 0 },
  path: { fontFamily: 'Menlo', fontSize: 12, lineHeight: 17 },
  subtitle: { fontSize: 12, lineHeight: 16 },
  action: { alignItems: 'center', borderRadius: 6, height: 28, justifyContent: 'center', width: 28 },
  body: { minWidth: 0 },
  state: { alignItems: 'center', flexDirection: 'row', gap: 9, minHeight: 92, paddingHorizontal: 14, paddingVertical: 16 },
  stateCopy: { flex: 1, gap: 2, minWidth: 0 },
  stateTitle: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  stateDetail: { fontSize: 12, lineHeight: 17 },
  retry: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  retryText: { fontSize: 12, fontWeight: '500', lineHeight: 17 },
  loading: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 96, padding: 18 },
  loadingText: { fontSize: 12, lineHeight: 17 },
  warning: { alignItems: 'center', flexDirection: 'row', gap: 7, paddingHorizontal: 12, paddingVertical: 7 },
  warningText: { flex: 1, fontSize: 12, lineHeight: 17 },
  pressed: { opacity: 0.6 },
});
