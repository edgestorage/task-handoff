import { useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { useRouter, type Href } from 'expo-router';

import { useMobileTheme } from '../components/theme';
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
  const tabs = useMemo(() => snapshot.tabs
    .filter((tab) => tab.controlPlaneId === directory.controlPlaneId && (scope.kind !== 'instance' || scope.instanceId === tab.instanceId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [directory.controlPlaneId, scope, snapshot.tabs]);

  if (!tabs.length) return header ? <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.emptyList}>{header}</ScrollView> : null;
  const close = async (tab: (typeof tabs)[number]) => {
    if (closingId) return;
    setClosingId(tab.id);
    try { await mobileBrowserController.close(tab.controlPlaneId, tab.instanceId, tab.id); }
    finally { setClosingId((current) => current === tab.id ? '' : current); }
  };

  return <ScrollView contentContainerStyle={styles.scrollContent} contentInsetAdjustmentBehavior="automatic">
    {header}
    <View style={styles.section}>
    <View style={styles.sectionHeading}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('browser.sessions')}</Text>
      <Text style={[styles.sectionCount, { color: colors.textMuted }]}>{tabs.length}</Text>
    </View>
    <View style={styles.list}>
      {tabs.map((tab) => {
        const instance = directory.instances.find((candidate) => candidate.id === tab.instanceId);
        const title = tab.title || t('browser.untitled');
        return <View key={tab.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
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
          <Pressable
            accessibilityLabel={t('browser.close')}
            accessibilityRole="button"
            disabled={Boolean(closingId)}
            hitSlop={8}
            onPress={() => { void close(tab); }}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <SystemIcon android="close" color={colors.textMuted} ios="xmark" size={17} />
          </Pressable>
        </View>;
      })}
    </View>
    </View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  section: { gap: 10, paddingHorizontal: 20, paddingTop: 16 },
  scrollContent: { paddingBottom: 24 }, emptyList: { flexGrow: 1 },
  sectionHeading: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '600', lineHeight: 24 },
  sectionCount: { fontSize: 13, lineHeight: 18 },
  list: { gap: 10 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, minHeight: 84, overflow: 'hidden', position: 'relative' },
  cardContent: { gap: 5, paddingHorizontal: 14, paddingVertical: 12, paddingRight: 46 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '500', lineHeight: 21 },
  url: { fontSize: 13, lineHeight: 18 },
  instance: { fontSize: 12, lineHeight: 17 },
  closeButton: { alignItems: 'center', height: 36, justifyContent: 'center', position: 'absolute', right: 8, top: 23, width: 30 },
  pressed: { opacity: 0.6 },
});
