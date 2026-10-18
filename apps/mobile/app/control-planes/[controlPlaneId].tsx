import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';

import { Icon } from '../../src/components/Icon';
import { useMobileTheme } from '../../src/components/theme';
import { ControlPlaneDetailContent } from '../../src/control-plane/ControlPlaneDetailContent';
import { sameMobileControlPlaneProfileIdentity, selectMobileControlPlaneProfile, type MobileControlPlaneProfile } from '../../src/control-plane/profile';
import { deleteMobileControlPlaneProfile, mobileProfileStore as profiles, mobileSecureStore } from '../../src/control-plane/runtime';
import { createDirectControlPlaneClient } from '../../src/control-plane/client';
import { loadMobileCurrentAccess } from '../../src/control-plane/current-access';
import type { ControlPlaneCurrentAuthorization } from '@task-handoff/protocol/control-plane-access';
import { useI18n, type Translate } from '../../src/i18n';
import { useMobileToast } from '../../src/components/MobileToast';

export default function ControlPlaneDetailScreen() {
  const { controlPlaneId, kind, fingerprint } = useLocalSearchParams<{ controlPlaneId: string; kind?: string; fingerprint?: string }>();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const toast = useMobileToast();
  const [profile, setProfile] = useState<MobileControlPlaneProfile>();
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [currentAccess, setCurrentAccess] = useState<ControlPlaneCurrentAuthorization>();

  useEffect(() => {
    let live = true;
    void Promise.all([profiles.list(), profiles.active()]).then(([stored, current]) => {
      if (!live) return;
      const match = selectMobileControlPlaneProfile(
        stored.filter((candidate) => candidate.identity.controlPlaneId === controlPlaneId),
        { fingerprint, kind },
        current,
      );
      setProfile(match);
      setActive(Boolean(match && current && sameMobileControlPlaneProfileIdentity(match, current)));
      if (match) {
        void loadMobileCurrentAccess(
          match,
          (directProfile) => createDirectControlPlaneClient(directProfile, mobileSecureStore).api.users.currentAuthorization(),
        )
          .then((access) => { if (live) setCurrentAccess(access); })
          .catch(() => { if (live) setCurrentAccess(undefined); });
      } else {
        setCurrentAccess(undefined);
      }
      setLoading(false);
    }).catch((cause) => {
      if (!live) return;
      setLoading(false);
    });
    return () => { live = false; };
  }, [controlPlaneId, kind, fingerprint, t]);

  const makeActive = async () => {
    if (!profile) return;
    setBusy(true);
    try {
      await profiles.setActive(profile);
      setActive(true);
    } catch (cause) {
      toast.show({ detail: messageFor(cause, t), title: t('toast.actionFailed', { action: t('controlPlane.makeActive') }), tone: 'error' });
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
            void deleteMobileControlPlaneProfile(profile).then((remaining) => {
              router.replace(remaining.length ? '/(tabs)/(main)/inbox' : '/profiles');
            }).catch((cause) => {
              toast.show({ detail: messageFor(cause, t), title: t('toast.actionFailed', { action: t('controlPlane.remove') }), tone: 'error' });
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
      <>
        <Stack.Screen options={{ title: t('nav.controlPlane') }} />
        <View style={[styles.empty, { backgroundColor: colors.background }]}>
          <Icon color={colors.textMuted} name="alert-circle-outline" size={30} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('controlPlane.notFound')}</Text>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>{t('controlPlane.maybeRemoved')}</Text>
        </View>
      </>
    );
  }

  const name = profile.identity.displayName || t('profiles.defaultName');
  return (
    <>
      <Stack.Screen options={{ title: name }} />
      <ControlPlaneDetailContent
        active={active}
        busy={busy}
        currentAccess={currentAccess}
        onMakeActive={() => { void makeActive(); }}
        onRemove={remove}
        profile={profile}
      />
    </>
  );
}

function messageFor(cause: unknown, t: Translate) {
  return cause instanceof Error ? cause.message : t('controlPlane.updateError');
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  empty: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 17, fontWeight: '600' },
  emptyText: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
