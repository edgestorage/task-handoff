import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';

import { Screen } from '../../src/components/Screen';
import { SystemIcon } from '../../src/components/SystemIcon';
import { useMobileTheme } from '../../src/components/theme';
import type { MobileControlPlaneProfile } from '../../src/control-plane/profile';
import { deleteMobileControlPlaneProfile, mobileProfileStore as profiles } from '../../src/control-plane/runtime';

export default function ControlPlaneDetailScreen() {
  const { controlPlaneId } = useLocalSearchParams<{ controlPlaneId: string }>();
  const { colors } = useMobileTheme();
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
      setError(messageFor(cause));
      setLoading(false);
    });
    return () => { live = false; };
  }, [controlPlaneId]);

  const makeActive = async () => {
    if (!profile) return;
    setBusy(true);
    setError(undefined);
    try {
      await profiles.setActive(profile);
      setActive(true);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (!profile) return;
    Alert.alert(
      'Remove Control Plane?',
      'This removes its local sessions, drafts, and cached state from this device. Nothing is removed from the Control Plane.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setError(undefined);
            void deleteMobileControlPlaneProfile(profile).then((remaining) => {
              router.replace(remaining.length ? '/(tabs)/profiles' : '/profiles');
            }).catch((cause) => {
              setError(messageFor(cause));
              setBusy(false);
            });
          },
        },
      ],
    );
  };

  if (loading) return <View style={[styles.loading, { backgroundColor: colors.background }]}><ActivityIndicator accessibilityLabel="Loading Control Plane" /></View>;

  if (!profile) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Control Plane' }} />
        <View style={styles.empty}>
          <SystemIcon android="error_outline" color={colors.textMuted} ios="exclamationmark.circle" size={30} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>Control Plane not found</Text>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>It may have been removed from this device.</Text>
        </View>
      </Screen>
    );
  }

  const name = profile.identity.displayName || 'Control Plane';
  return (
    <Screen>
      <Stack.Screen options={{ title: name }} />

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>CONNECTION</Text>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
          <DetailRow colors={colors} label="Status" value={active ? 'Active on this device' : 'Saved'} valueColor={active ? colors.primary : undefined} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow colors={colors} label="Address" value={profile.access.origin} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow colors={colors} label="Control Plane ID" value={profile.identity.controlPlaneId} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow colors={colors} label="Signing fingerprint" value={profile.identity.publicKeyFingerprint} />
        </View>
        <Text style={[styles.footnote, { color: colors.textMuted }]}>The signing fingerprint identifies the Control Plane that was verified when this connection was added.</Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>ACTIONS</Text>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {!active ? <>
            <ActionRow disabled={busy} icon={{ android: 'check_circle', ios: 'checkmark.circle' }} label="Make Active" onPress={() => { void makeActive(); }} tint={colors.primary} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
          </> : null}
          <ActionRow disabled={busy} icon={{ android: 'delete', ios: 'trash' }} label="Remove Control Plane" onPress={remove} tint={colors.error} />
        </View>
        <Text style={[styles.footnote, { color: colors.textMuted }]}>Removing only clears this device. Nodes, instances, and AI sessions on the Control Plane are unchanged.</Text>
      </View>

      {busy ? <ActivityIndicator accessibilityLabel="Updating Control Plane" /> : null}
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

function messageFor(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Could not update the Control Plane.';
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
