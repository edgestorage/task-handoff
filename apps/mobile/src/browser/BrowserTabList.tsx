import { useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { useRouter, type Href } from 'expo-router';

import { useMobileTheme } from '../components/theme';
import { EmptyState } from '../components/EmptyState';
import { SwipeActionList } from '../components/SwipeActionList';
import { usePullToRefresh } from '../components/use-pull-to-refresh';
import { SystemIcon } from '../components/SystemIcon';
import type { MobileDirectoryProfileState } from '../directories/store';
import type { AiSessionScope } from '../ai-sessions/store';
import { useI18n } from '../i18n';
import { mobileBrowserController } from './controller';
import { mobileBrowserTabStore } from './store';

type Props = {
  directory: MobileDirectoryProfileState;
  scope: Extract<AiSessionScope, { kind: 'all' | 'instance' }>;
  header?: ReactNode;
};

/** Local browser tabs remain visible in the App Sessions area after leaving the browser route. */
export function BrowserTabList({ directory, scope, header }: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const router = useRouter();
  const snapshot = useSyncExternalStore(mobileBrowserTabStore.subscribe, mobileBrowserTabStore.snapshot, mobileBrowserTabStore.snapshot);
  const [closingId, setClosingId] = useState('');
  const pullToRefresh = usePullToRefresh();
  const tabs = useMemo(() => snapshot.tabs
    .filter((tab) => tab.controlPlaneId === directory.controlPlaneId && (scope.kind !== 'instance' || scope.instanceId === tab.instanceId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [directory.controlPlaneId, scope, snapshot.tabs]);

  const close = async (tab: (typeof tabs)[number]) => {
    if (closingId) return;
    setClosingId(tab.id);
    try { await mobileBrowserController.close(tab.controlPlaneId, tab.instanceId, tab.id); }
    finally { setClosingId((current) => current === tab.id ? '' : current); }
  };

  return <SwipeActionList
    contentContainerStyle={styles.list}
    data={tabs}
    itemContainerStyle={styles.cardContainer}
    keyExtractor={(tab) => tab.id}
    ListEmptyComponent={<EmptyState icon={{ android: 'language', ios: 'globe' }} message={t('browser.empty')} style={styles.empty} />}
    ListHeaderComponent={header}
    onRefresh={pullToRefresh.onRefresh}
    refreshing={pullToRefresh.refreshing}
    swipeAction={(tab) => ({
      disabled: Boolean(closingId),
      label: t('browser.close'),
      onPress: () => { void close(tab); },
    })}
    renderItem={({ item: tab }) => {
        const instance = directory.instances.find((candidate) => candidate.id === tab.instanceId);
        const title = tab.title || t('browser.untitled');
        return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/browser/${encodeURIComponent(tab.instanceId)}/${encodeURIComponent(tab.id)}` as Href)}
            style={({ pressed }) => [styles.cardContent, pressed && styles.pressed]}
          >
            <View style={styles.titleRow}>
              <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{title}</Text>
              {tab.loading ? <ActivityIndicator color={colors.primary} size="small" /> : <SystemIcon android="language" color={colors.textMuted} ios="globe" size={15} />}
            </View>
            <Text numberOfLines={1} style={[styles.url, { color: colors.textMuted }]}>{tab.currentUrl}</Text>
            <Text numberOfLines={1} style={[styles.instance, { color: colors.textMuted }]}>{instance?.name || tab.instanceId}</Text>
          </Pressable>
        </View>;
    }}
    style={{ backgroundColor: colors.background }}
  />;
}

const styles = StyleSheet.create({
  list: { paddingTop: 16, paddingBottom: 24 }, cardContainer: { marginBottom: 12, marginHorizontal: 20 }, empty: { minHeight: 240 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, minHeight: 84, overflow: 'hidden' },
  cardContent: { gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '500', lineHeight: 21 },
  url: { fontSize: 13, lineHeight: 18 },
  instance: { fontSize: 12, lineHeight: 17 },
  pressed: { opacity: 0.6 },
});
