import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';

import { Screen } from '../../src/components/Screen';
import { SystemIcon } from '../../src/components/SystemIcon';
import { useMobileTheme } from '../../src/components/theme';
import type { MobileControlPlaneProfile } from '../../src/control-plane/profile';
import { deleteMobileControlPlaneProfile, mobileProfileStore as profiles } from '../../src/control-plane/runtime';
import { useI18n, type Translate } from '../../src/i18n';

export default function ControlPlaneDetailScreen() {
  const { controlPlaneId } = useLocalSearchParams<{ controlPlaneId: string }>();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [profile, setProfile] = useState<MobileControlPlaneProfile>();
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    void Promise.all([profiles.list(), profiles.active()]).then(([stored, current]) => {
      if (!live) return;
      const match = stored.find((candidate) => candidate.identity.controlPlaneId === controlPlaneId);
      setProfile(match);
      setActive(Boolean(match && current?.identity.controlPlaneId === match.identity.controlPlaneId));
      setLoading(false);
    }).catch((cause) => {
      if (!live) return;
      setError(messageFor(cause, t));
      setLoading(false);
    });
    return () => { live = false; };
  }, [controlPlaneId, t]);

  const makeActive = async () => {
    if (!profile) return;
    setBusy(true);
    setError(undefined);
    try {
      await profiles.setActive(profile);
      setActive(true);
    } catch (cause) {
      setError(messageFor(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (!profile) return;
    Alert.alert(
      t('controlPlane.removeTitle'),
      t('controlPlane.removeDescription'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.remove'),
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setError(undefined);
            void deleteMobileControlPlaneProfile(profile).then((remaining) => {
              router.replace(remaining.length ? '/(tabs)/(main)/inbox' : '/profiles');
            }).catch((cause) => {
              setError(messageFor(cause, t));
              setBusy(false);
            });
          },
        },
      ],
    );
  };

  if (loading) return <View style={[styles.loading, { backgroundColor: colors.background }]}><ActivityIndicator accessibilityLabel={t('controlPlane.loading')} /></View>;

  if (!profile) {
    return (
      <Screen>
        <Stack.Screen options={{ title: t('nav.controlPlane') }} />
        <View style={styles.empty}>
          <SystemIcon android="error_outline" color={colors.textMuted} ios="exclamationmark.circle" size={30} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('controlPlane.notFound')}</Text>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>{t('controlPlane.maybeRemoved')}</Text>
        </View>
      </Screen>
    );
  }

  const name = profile.identity.displayName || t('profiles.defaultName');
  return (
    <Screen>
      <Stack.Screen options={{ title: name }} />

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('controlPlane.connection')}</Text>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
          <DetailRow colors={colors} label={t('controlPlane.status')} value={active ? t('controlPlane.active') : t('controlPlane.saved')} valueColor={active ? colors.primary : undefined} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow colors={colors} label={t('controlPlane.address')} value={profile.access.origin} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow colors={colors} label={t('controlPlane.id')} value={profile.identity.controlPlaneId} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow colors={colors} label={t('controlPlane.fingerprint')} value={profile.identity.publicKeyFingerprint} />
        </View>
        <Text style={[styles.footnote, { color: colors.textMuted }]}>{t('controlPlane.fingerprintHelp')}</Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('controlPlane.actions')}</Text>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {!active ? <>
            <ActionRow disabled={busy} icon={{ android: 'check_circle', ios: 'checkmark.circle' }} label={t('controlPlane.makeActive')} onPress={() => { void makeActive(); }} tint={colors.primary} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
          </> : null}
          <ActionRow disabled={busy} icon={{ android: 'delete', ios: 'trash' }} label={t('controlPlane.remove')} onPress={remove} tint={colors.error} />
        </View>
        <Text style={[styles.footnote, { color: colors.textMuted }]}>{t('controlPlane.removeHelp')}</Text>
      </View>

      {busy ? <ActivityIndicator accessibilityLabel={t('controlPlane.updating')} /> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
    </Screen>
  );
}

function DetailRow({ colors, label, value, valueColor }: { colors: ReturnType<typeof useMobileTheme>['colors']; label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: colors.text }]}>{label}</Text>
      <Text numberOfLines={2} selectable style={[styles.detailValue, { color: valueColor ?? colors.textMuted }]}>{value}</Text>
    </View>
  );
}

function ActionRow({ disabled, icon, label, onPress, tint }: { disabled: boolean; icon: { android: 'check_circle' | 'delete'; ios: 'checkmark.circle' | 'trash' }; label: string; onPress(): void; tint: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.actionRow, disabled && styles.disabled, pressed && styles.pressed]}>
      <SystemIcon android={icon.android} color={tint} ios={icon.ios} size={18} />
      <Text style={[styles.actionLabel, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

function messageFor(cause: unknown, t: Translate) {
  return cause instanceof Error ? cause.message : t('controlPlane.updateError');
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  empty: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', paddingVertical: 64 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyText: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  section: { gap: 7 },
  sectionLabel: { fontSize: 12, marginLeft: 16 },
  group: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  detailRow: { gap: 4, minHeight: 58, paddingHorizontal: 16, paddingVertical: 10 },
  detailLabel: { fontSize: 15 },
  detailValue: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  footnote: { fontSize: 12, lineHeight: 17, marginHorizontal: 16 },
  actionRow: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 50, paddingHorizontal: 16 },
  actionLabel: { fontSize: 16 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.55 },
  error: { fontSize: 13, lineHeight: 19 },
});
