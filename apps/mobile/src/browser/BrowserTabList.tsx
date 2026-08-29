import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { useMobileTheme } from '../components/theme';
import { EmptyState } from '../components/EmptyState';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { mobileBrowserCapability } from '../control-plane/browser-context';
import type { MobileDirectoryProfileState } from '../directories/store';
import type { AiSessionScope } from '../ai-sessions/store';
import { useI18n } from '../i18n';
import { mobileBrowserController } from './controller';
import { mobileBrowserTabStore } from './store';

type Props = {
  directory: MobileDirectoryProfileState;
  scope: Extract<AiSessionScope, { kind: 'all' | 'instance' }>;
};

export function BrowserTabList({ directory, scope }: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const router = useRouter();
  const runtime = useMobileControlPlaneRuntime();
  const snapshot = useSyncExternalStore(mobileBrowserTabStore.subscribe, mobileBrowserTabStore.snapshot, mobileBrowserTabStore.snapshot);
  const [supportedIds, setSupportedIds] = useState<Set<string>>();
  const [creating, setCreating] = useState(false);
  const instances = useMemo(() => directory.instances.filter((instance) => scope.kind !== 'instance' || scope.instanceId === instance.id), [directory.instances, scope]);
  const tabs = useMemo(() => snapshot.tabs.filter((tab) => tab.controlPlaneId === runtime.controlPlaneId && (scope.kind !== 'instance' || scope.instanceId === tab.instanceId)), [runtime.controlPlaneId, scope, snapshot.tabs]);

  useEffect(() => {
    let live = true;
    const capabilityChecks = runtime.profile
      ? Promise.all(instances.map(async (instance) => [instance.id, await mobileBrowserCapability(runtime.profile!, instance.capabilities)] as const))
      : Promise.resolve([] as const);
    void capabilityChecks
      .then((results) => { if (live) setSupportedIds(new Set(results.filter(([, capability]) => capability.supported).map(([id]) => id))); })
      .catch(() => { if (live) setSupportedIds(new Set()); });
    return () => { live = false; };
  }, [instances, runtime.profile]);

  const createFor = async (instanceId: string) => {
    if (!runtime.api || !runtime.profile) return;
    setCreating(true);
    try {
      const tab = await mobileBrowserController.create({ api: runtime.api, profile: runtime.profile, instanceId });
      router.push(`/browser/${encodeURIComponent(instanceId)}/${encodeURIComponent(tab.id)}` as Href);
    } catch (cause) {
      Alert.alert(t('browser.createFailed'), cause instanceof Error ? cause.message : undefined);
    } finally { setCreating(false); }
  };
  const requestCreate = () => {
    const supported = instances.filter((instance) => supportedIds?.has(instance.id));
    if (supported.length === 1) { void createFor(supported[0].id); return; }
    if (!supported.length) return;
    Alert.alert(t('browser.selectInstance'), undefined, [
      ...supported.slice(0, 8).map((instance) => ({ text: instance.name, onPress: () => { void createFor(instance.id); } })),
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  };

  if (!supportedIds) return <ActivityIndicator style={styles.loading} />;
  const available = supportedIds.size > 0;
  return <ScrollView contentContainerStyle={styles.content} style={{ backgroundColor: colors.background }}>
    <Pressable
      accessibilityRole="button"
      disabled={!available || creating}
      onPress={requestCreate}
      style={({ pressed }) => [styles.newButton, { backgroundColor: colors.primaryButton }, (!available || creating) && styles.disabled, pressed && styles.pressed]}
    >
      {creating ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.newButtonText}>{t('browser.new')}</Text>}
    </Pressable>
    {!available ? <EmptyState icon={{ android: 'language', ios: 'globe' }} message={t('browser.unavailable')} style={styles.empty} /> : null}
    {available && !tabs.length ? <EmptyState icon={{ android: 'language', ios: 'globe' }} message={t('browser.empty')} style={styles.empty} /> : null}
    {tabs.map((tab) => {
      const instance = directory.instances.find((candidate) => candidate.id === tab.instanceId);
      return <Pressable
        accessibilityRole="button"
        key={tab.id}
        onPress={() => router.push(`/browser/${encodeURIComponent(tab.instanceId)}/${encodeURIComponent(tab.id)}` as Href)}
        style={({ pressed }) => [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}
      >
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{tab.title || t('browser.untitled')}</Text>
        <Text numberOfLines={1} style={[styles.url, { color: colors.textMuted }]}>{tab.currentUrl}</Text>
        <Text numberOfLines={1} style={[styles.instance, { color: colors.textMuted }]}>{instance?.name || tab.instanceId}</Text>
      </Pressable>;
    })}
  </ScrollView>;
}

const styles = StyleSheet.create({
  loading: { flex: 1 }, content: { gap: 12, padding: 20, paddingBottom: 40 },
  newButton: { alignItems: 'center', borderRadius: 8, minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  newButtonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.65 },
  empty: { minHeight: 220 }, card: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, gap: 5, padding: 14 },
  title: { fontSize: 16, fontWeight: '500', lineHeight: 21 }, url: { fontSize: 13, lineHeight: 18 }, instance: { fontSize: 12, lineHeight: 17 },
});
