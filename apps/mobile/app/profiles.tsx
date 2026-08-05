import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';

import { Screen } from '../src/components/Screen';
import type { MobileControlPlaneProfile } from '../src/control-plane/profile';
import { mobileProfileStore as profiles } from '../src/control-plane/runtime';
import { useMobileTheme } from '../src/components/theme';
import { isMobileTestMode } from '../src/platform/build-variant';
import { SystemIcon } from '../src/components/SystemIcon';
import { NativeProfilesScreen } from '../src/control-plane/NativeProfilesScreen';
import { NativeActionButton } from '../src/components/NativeActionButton';

export default function ProfilesScreen({ embeddedInTabs = false }: { embeddedInTabs?: boolean }) {
  const { colors } = useMobileTheme();
  const [error, setError] = useState<string>();
  const [savedProfiles, setSavedProfiles] = useState<MobileControlPlaneProfile[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [profilesLoaded, setProfilesLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => Promise.all([profiles.list(), profiles.active()]).then(([stored, active]) => {
      if (!live) return;
      setSavedProfiles(stored);
      setActiveId(active?.identity.controlPlaneId);
      setProfilesLoaded(true);
    }).catch((cause) => {
      if (!live) return;
      setError(cause instanceof Error ? cause.message : 'Could not load Control Planes.');
      setProfilesLoaded(true);
    });
    void load();
    const unsubscribe = profiles.subscribe(() => { void load(); });
    return () => { live = false; unsubscribe(); };
  }, []);

  if (!profilesLoaded) {
    return (
      <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.loadingScreen}><ActivityIndicator accessibilityLabel="Loading Control Planes" /></View>
      </SafeAreaView>
    );
  }

  if (!savedProfiles.length) {
    return (
      <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: colors.background }]}> 
        <Stack.Screen options={{ headerShown: false }} />
        <Screen>
          <ProfilesWelcome onAdd={() => router.push('/control-planes/add')} />
        </Screen>
      </SafeAreaView>
    );
  }

  if (Platform.OS === 'ios') {
    return <NativeProfilesScreen
      activeId={activeId}
      error={error}
      profiles={savedProfiles}
      profilesLoaded={profilesLoaded}
      testMode={isMobileTestMode}
      onAdd={() => router.push('/control-planes/add')}
      onOpen={(controlPlaneId) => router.push({ pathname: '/control-planes/[controlPlaneId]', params: { controlPlaneId } })}
    />;
  }

  return (
    <SafeAreaView edges={embeddedInTabs ? ['top'] : []} style={[styles.safeArea, { backgroundColor: colors.background }]}> 
      <Stack.Screen options={{ headerShown: !embeddedInTabs }} />
      <Screen>
        <View style={styles.saved}>
          <View style={styles.savedHeading}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Control Planes</Text>
          </View>
          <View style={[styles.profileGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
            {savedProfiles.map((profile, index) => {
              const active = activeId === profile.identity.controlPlaneId;
              return <View key={`${profile.identity.controlPlaneId}:${profile.identity.publicKeyFingerprint}`}>
                {index ? <View style={[styles.profileDivider, { backgroundColor: colors.border }]} /> : null}
                <Pressable
                  accessibilityLabel={`View ${profile.identity.displayName || 'Control Plane'} details`}
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: '/control-planes/[controlPlaneId]', params: { controlPlaneId: profile.identity.controlPlaneId } })}
                  style={({ pressed }) => [styles.profileRow, pressed && { backgroundColor: colors.surfaceMuted }]}
                >
                  <View style={[styles.profileIcon, { backgroundColor: colors.surfaceMuted }]}> 
                    <SystemIcon android="dns" color={colors.textMuted} ios="server.rack" size={19} />
                  </View>
                  <View style={styles.profileIdentity}>
                    <View style={styles.profileNameRow}>
                      <Text numberOfLines={1} style={[styles.profileName, { color: colors.text }]}>{profile.identity.displayName || 'Control Plane'}</Text>
                      {active ? <SystemIcon android="check_circle" color={colors.primary} ios="checkmark.circle.fill" size={16} /> : null}
                    </View>
                    <Text selectable numberOfLines={1} style={[styles.profileOrigin, { color: colors.textMuted }]}>{profile.access.origin}</Text>
                  </View>
                  <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={13} />
                </Pressable>
              </View>
            })}
            <View style={[styles.profileDivider, { backgroundColor: colors.border }]} />
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/control-planes/add')}
              style={({ pressed }) => [styles.addRow, pressed && { backgroundColor: colors.surfaceMuted }]}
            >
              <View style={[styles.addIcon, { backgroundColor: colors.primarySoft }]}> 
                <SystemIcon android="add" color={colors.primary} ios="plus" size={17} />
              </View>
              <Text style={[styles.addRowText, { color: colors.primary }]}>Add Control Plane</Text>
              <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={13} />
            </Pressable>
          </View>
        </View>
        {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
      </Screen>
    </SafeAreaView>
  );
}

export function ProfilesWelcome({ onAdd }: { onAdd: () => void }) {
  const { colors } = useMobileTheme();

  return (
    <View style={styles.welcome}>
      <View style={styles.hero}>
        <Image accessibilityIgnoresInvertColors source={require('../assets/icon.png')} style={styles.brandIcon} />
        <Text style={[styles.brandName, { color: colors.text }]}>TaskHandoff</Text>
        <Text accessibilityRole="header" style={[styles.heroTitle, { color: colors.text }]}>Your AI work, with you.</Text>
        <Text style={[styles.heroDescription, { color: colors.textMuted }]}>Connect this device to your Control Plane to follow work, review progress, and respond wherever you are.</Text>
      </View>

      <View style={[styles.guideCard, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
        <GuideItem colors={colors} icon={{ android: 'lock', ios: 'lock' }} title="Connect securely" description="We verify the Control Plane’s signed identity before sending your password." />
        <View style={[styles.guideDivider, { backgroundColor: colors.border }]} />
        <GuideItem colors={colors} icon={{ android: 'sync', ios: 'arrow.triangle.2.circlepath' }} title="Keep sessions in sync" description="See active AI sessions and their latest state from one mobile inbox." />
        <View style={[styles.guideDivider, { backgroundColor: colors.border }]} />
        <GuideItem colors={colors} icon={{ android: 'visibility', ios: 'eye' }} title="Stay in control" description="Review progress and respond without taking runtime ownership away from your Control Plane." />
      </View>

      <View style={styles.welcomeFooter}>
        <NativeActionButton label="Connect a Control Plane" onPress={onAdd} />
        <Text style={[styles.requirement, { color: colors.textMuted }]}>{isMobileTestMode ? 'Have your Control Plane address and sign-in ready. HTTP is allowed in this test build.' : 'Have your HTTPS Control Plane address and sign-in ready.'}</Text>
      </View>
    </View>
  );
}

function GuideItem({ colors, icon, title, description }: { colors: ReturnType<typeof useMobileTheme>['colors']; icon: { android: AndroidSymbol; ios: SFSymbol }; title: string; description: string }) {
  return (
    <View style={styles.guideItem}>
      <View style={styles.guideIcon}>
        <SystemIcon android={icon.android} color={colors.primary} ios={icon.ios} size={21} />
      </View>
      <View style={styles.guideCopy}>
        <Text style={[styles.guideTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.guideDescription, { color: colors.textMuted }]}>{description}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  loadingScreen: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  welcome: { flex: 1, gap: 24, paddingBottom: 8, paddingTop: 12 },
  brandIcon: { borderRadius: 18, height: 72, width: 72 },
  brandName: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  hero: { alignItems: 'center', gap: 9, paddingHorizontal: 12 },
  heroTitle: { fontSize: 30, fontWeight: '700', letterSpacing: -0.8, lineHeight: 36, textAlign: 'center' },
  heroDescription: { fontSize: 15, lineHeight: 22, maxWidth: 340, textAlign: 'center' },
  guideCard: { borderRadius: 18, borderWidth: 1, paddingHorizontal: 16 },
  guideItem: { flexDirection: 'row', gap: 12, paddingVertical: 15 },
  guideIcon: { alignItems: 'center', marginTop: 2, width: 24 },
  guideCopy: { flex: 1, gap: 3 },
  guideTitle: { fontSize: 15, fontWeight: '700' },
  guideDescription: { fontSize: 13, lineHeight: 19 },
  guideDivider: { height: StyleSheet.hairlineWidth, marginLeft: 36 },
  welcomeFooter: { gap: 10, marginTop: 'auto' },
  requirement: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  saved: { gap: 12, marginBottom: 18 },
  savedHeading: { alignItems: 'baseline', flexDirection: 'row' },
  profileGroup: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  profileDivider: { height: StyleSheet.hairlineWidth, marginLeft: 61 },
  profileRow: { alignItems: 'center', flexDirection: 'row', gap: 11, minHeight: 64, paddingHorizontal: 12, paddingVertical: 9 },
  profileIcon: { alignItems: 'center', borderRadius: 9, height: 38, justifyContent: 'center', width: 38 },
  profileIdentity: { flex: 1, gap: 2 },
  profileNameRow: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  profileName: { flexShrink: 1, fontSize: 16, fontWeight: '600' },
  profileOrigin: { fontSize: 13, lineHeight: 18 },
  addRow: { alignItems: 'center', flexDirection: 'row', gap: 11, minHeight: 56, paddingHorizontal: 12 },
  addIcon: { alignItems: 'center', borderRadius: 8, height: 32, justifyContent: 'center', width: 32 },
  addRowText: { flex: 1, fontSize: 16, fontWeight: '600' },
  title: { color: '#111827', fontSize: 28, fontWeight: '700' },
  buttonPressed: { opacity: 0.8 },
  fingerprint: { color: '#6b7280', fontFamily: 'monospace', fontSize: 12 },
  error: { color: '#b91c1c', fontSize: 13, lineHeight: 19 },
});
