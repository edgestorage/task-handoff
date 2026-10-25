import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import type { ControlPlaneDirectoryEntry } from '@task-handoff/cloud-contracts/mobile';

import { Screen } from '../src/components/Screen';
import { useMobileTheme } from '../src/components/theme';
import { cloudMobileErrorMessage } from '../src/control-plane/cloud-error';
import { controlPlaneRoleMessageKey } from '../src/control-plane/current-access';
import { MobileCloudRelayControlPlaneProfileSchema } from '../src/control-plane/profile';
import { mobileProfileStore, reconcileCloudControlPlaneProfiles, restoreActiveCloudAccountSession } from '../src/control-plane/runtime';
import { useI18n } from '../src/i18n';
import { isMobileFeatureEnabled } from '../src/platform/build-variant';

export default function CloudControlPlanesScreen() {
  if (!isMobileFeatureEnabled('officialAccount')) return <Redirect href="/profiles" />;
  return <CloudControlPlanesContent />;
}

function CloudControlPlanesContent() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const zh = locale === 'zh-CN';
  const [items, setItems] = useState<ControlPlaneDirectoryEntry[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    async function load() {
      setError(undefined);
      setLoading(true);
      try {
        const session = await restoreActiveCloudAccountSession();
        const directory = await session.client.listControlPlanes();
        await reconcileCloudControlPlaneProfiles(session.reference().id, directory);
        if (live) setItems(directory);
      } catch (cause) {
        if (live) setError(cloudMobileErrorMessage(cause, zh));
      } finally {
        if (live) setLoading(false);
      }
    }
    void load();
    return () => { live = false; };
  }, [zh]);

  async function add(entry: ControlPlaneDirectoryEntry) {
    try {
      if (typeof entry.bindingId !== 'string') throw Object.assign(new Error('Unsupported directory version'), { code: 'CLOUD_DIRECTORY_BINDING_ID_UNSUPPORTED' });
      const session = await restoreActiveCloudAccountSession();
      const now = new Date().toISOString();
      const profile = MobileCloudRelayControlPlaneProfileSchema.parse({
        version: 1,
        identity: {
          controlPlaneId: entry.controlPlaneId,
          publicKeyFingerprint: entry.publicKeyFingerprint,
          displayName: entry.displayName.translations?.[locale] || entry.displayName.default,
          protocolVersion: '2026-08-10',
        },
        access: {
          kind: 'cloud-relay',
          serviceOrigin: session.origin,
          bindingId: entry.bindingId,
          bindingRevision: entry.bindingRevision,
          accountSession: session.reference(),
          resourceAccess: entry.access ?? { kind: 'owner' },
          transport: { request: true, stream: true, webSocket: true },
        },
        capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true, stories: true },
        createdAt: now,
        updatedAt: now,
      });
      await mobileProfileStore.put(profile);
      router.replace('/(tabs)/(main)/inbox');
    } catch (cause) {
      setError(cloudMobileErrorMessage(cause, zh));
    }
  }

  return <>
    <Stack.Screen options={{ title: t('cloudControlPlanes.title') }}/>
    <Screen>
      <Pressable accessibilityRole="button" onPress={() => router.push('/cloud-account-security' as never)}>
        <Text style={[styles.accountLink, { color: colors.primary }]}>{t('cloudAccount.settings')}</Text>
      </Pressable>
      <Text style={[styles.note, { color: colors.textMuted }]}>{t('cloudControlPlanes.note')}</Text>
      {loading ? <View accessibilityLiveRegion="polite" style={styles.loading}>
        <ActivityIndicator accessibilityLabel={t('cloudControlPlanes.loading')} color={colors.primary}/>
        <Text style={[styles.loadingText, { color: colors.textMuted }]}>{t('cloudControlPlanes.loading')}</Text>
      </View> : null}
      {!loading ? items.map((entry) => {
        const accessLabel = accessLabelFor(entry, t);
        const name = entry.displayName.translations?.[locale] || entry.displayName.default || entry.controlPlaneId;
        return <Pressable
          accessibilityLabel={t('cloudControlPlanes.open', { name })}
          accessibilityRole="button"
          key={`${entry.controlPlaneId}:${entry.publicKeyFingerprint}`}
          onPress={() => void add(entry)}
          style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
          testID="cloud-control-plane-row"
        >
          <View style={styles.copy}>
            <Text style={[styles.name, { color: colors.text }]}>{name}</Text>
            <Text numberOfLines={1} style={[styles.fingerprint, { color: colors.textMuted }]}>{entry.publicKeyFingerprint}</Text>
            <Text style={[styles.access, { color: entry.access?.kind === 'shared' ? colors.primary : colors.textMuted }]}>{accessLabel}</Text>
          </View>
          <Text style={{ color: entry.remoteAccess === 'enabled' ? colors.primary : colors.textMuted }}>{remoteAccessLabel(entry.remoteAccess, t)}</Text>
        </Pressable>;
      }) : null}
      {!loading && !items.length && !error ? <Text style={[styles.empty, { color: colors.textMuted }]}>{t('cloudControlPlanes.empty')}</Text> : null}
      {!loading && error ? <Text accessibilityLiveRegion="polite" style={[styles.empty, { color: colors.error }]}>{error}</Text> : null}
    </Screen>
  </>;
}

function accessLabelFor(entry: ControlPlaneDirectoryEntry, t: ReturnType<typeof useI18n>['t']) {
  if (entry.access?.kind !== 'shared') return t('cloudControlPlanes.owner');
  const roleKey = controlPlaneRoleMessageKey(entry.access.role);
  const role = roleKey ? t(roleKey) : entry.access.role;
  return t('cloudControlPlanes.sharedRole', { role });
}

function remoteAccessLabel(value: ControlPlaneDirectoryEntry['remoteAccess'], t: ReturnType<typeof useI18n>['t']) {
  if (value === 'enabled') return t('cloudControlPlanes.remoteEnabled');
  if (value === 'revocation-pending') return t('cloudControlPlanes.remoteRevocationPending');
  return t('cloudControlPlanes.remoteDisabled');
}

const styles = StyleSheet.create({
  accountLink: { fontSize: 15, fontWeight: '600' },
  note: { fontSize: 14, lineHeight: 20 },
  loading: { alignItems: 'center', gap: 10, justifyContent: 'center', minHeight: 180, paddingVertical: 24 },
  loadingText: { fontSize: 14 },
  row: { alignItems: 'center', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, padding: 14 },
  copy: { flex: 1, gap: 4 },
  name: { fontSize: 16, fontWeight: '600' },
  fingerprint: { fontFamily: 'monospace', fontSize: 12 },
  access: { fontSize: 13, fontWeight: '600' },
  empty: { fontSize: 14, padding: 24, textAlign: 'center' },
});
