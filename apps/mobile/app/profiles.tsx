import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Image, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OptionMenu, type OptionMenuOption } from '../src/components/OptionMenu';
import { Icon, type IconName } from '../src/components/Icon';
import { Screen } from '../src/components/Screen';
import { mobileControlPlaneProfileConnectionLabel } from '../src/control-plane/connection-presentation';
import { sameMobileControlPlaneProfileIdentity, type MobileControlPlaneProfile } from '../src/control-plane/profile';
import { mobileProfileStore as profiles } from '../src/control-plane/runtime';
import { useCloudAccountState, type CloudAccountState } from '../src/control-plane/use-cloud-account-state';
import { useMobileTheme, type AppearancePreference } from '../src/components/theme';
import { isMobileFeatureEnabled, isMobileTestMode } from '../src/platform/build-variant';
import { NativeProfilesScreen } from '../src/control-plane/NativeProfilesScreen';
import { NativeActionButton } from '../src/components/NativeActionButton';
import { useI18n, type LocalePreference } from '../src/i18n';
import { clearDiagnosticLogs, copyRecentDiagnosticLogs, getDiagnosticLogsEnabled, setDiagnosticLogsEnabled, subscribeDiagnosticLogs } from '../src/observability/diagnostic-logs';

export default function ProfilesScreen({ embeddedInTabs = false }: { embeddedInTabs?: boolean }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const cloudAccount = useCloudAccountState();
  const cloudAccountEnabled = isMobileFeatureEnabled('officialAccount');
  const [error, setError] = useState<string>();
  const [savedProfiles, setSavedProfiles] = useState<MobileControlPlaneProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<MobileControlPlaneProfile>();
  const [profilesLoaded, setProfilesLoaded] = useState(false);

  const openCloudAccount = () => {
    if (cloudAccount.phase === 'loading') return;
    router.push(cloudAccount.phase === 'signed-in' ? '/cloud-account-security' as never : '/cloud-account' as never);
  };

  useEffect(() => {
    let live = true;
    const load = () => Promise.all([profiles.list(), profiles.active()]).then(([stored, active]) => {
      if (!live) return;
      setSavedProfiles(stored);
      setActiveProfile(active);
      setProfilesLoaded(true);
    }).catch((cause) => {
      if (!live) return;
      setError(cause instanceof Error ? cause.message : t('profiles.loadError'));
      setProfilesLoaded(true);
    });
    void load();
    const unsubscribe = profiles.subscribe(() => { void load(); });
    return () => { live = false; unsubscribe(); };
  }, [t]);

  if (!profilesLoaded) {
    return (
      <SafeAreaView edges={embeddedInTabs ? [] : ['top']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false, title: t('nav.settings') }} />
        <View style={styles.loadingScreen}><ActivityIndicator accessibilityLabel={t('profiles.loading')} /></View>
      </SafeAreaView>
    );
  }

  if (!savedProfiles.length) {
    return (
      <SafeAreaView edges={embeddedInTabs ? [] : ['top']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false, title: t('nav.settings') }} />
        <Screen alwaysBounceVertical={false}>
          <ProfilesWelcome
            cloudAccount={cloudAccountEnabled ? cloudAccount : undefined}
            onAdd={() => router.push('/control-planes/add')}
            onOpenCloudAccount={openCloudAccount}
          />
        </Screen>
      </SafeAreaView>
    );
  }

  if (Platform.OS === 'ios') {
    return <><Stack.Screen options={{ headerShown: true, title: t('nav.settings') }} /><NativeProfilesScreen
      activeProfile={activeProfile}
      cloudAccount={cloudAccountEnabled ? cloudAccount : undefined}
      error={error}
      profiles={savedProfiles}
      profilesLoaded={profilesLoaded}
      testMode={isMobileTestMode}
      onAdd={() => router.push('/control-planes/add')}
      onOpenCloudAccount={openCloudAccount}
      onOpen={(profile) => router.push({ pathname: '/control-planes/[controlPlaneId]', params: { controlPlaneId: profile.identity.controlPlaneId, fingerprint: profile.identity.publicKeyFingerprint, kind: profile.access.kind } })}
    /></>;
  }

  return (
    <SafeAreaView edges={[]} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: t('nav.settings') }} />
      <Screen>
        <View style={styles.saved}>
          {cloudAccountEnabled ? <CloudAccountRow cloudAccount={cloudAccount} onPress={openCloudAccount} /> : null}
          {!embeddedInTabs ? <View style={styles.savedHeading}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('nav.controlPlanes')}</Text>
          </View> : null}
          <View style={[styles.profileGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
            {savedProfiles.map((profile, index) => {
              const active = Boolean(activeProfile && sameMobileControlPlaneProfileIdentity(activeProfile, profile));
              return <View key={`${profile.access.kind}:${profile.identity.controlPlaneId}:${profile.identity.publicKeyFingerprint}`}>
                {index ? <View style={[styles.profileDivider, { backgroundColor: colors.border }]} /> : null}
                <Pressable
                  accessibilityLabel={t('profiles.viewDetails', { name: profile.identity.displayName || t('profiles.defaultName') })}
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: '/control-planes/[controlPlaneId]', params: { controlPlaneId: profile.identity.controlPlaneId, fingerprint: profile.identity.publicKeyFingerprint, kind: profile.access.kind } })}
                  style={({ pressed }) => [styles.profileRow, pressed && { backgroundColor: colors.surface }]}
                >
                  <View style={[styles.profileIcon, { backgroundColor: colors.surface }]}>
                    <Icon color={colors.textMuted} name="server-outline" size={19} />
                  </View>
                  <View style={styles.profileIdentity}>
                    <View style={styles.profileNameRow}>
                      <Text numberOfLines={1} style={[styles.profileName, { color: colors.text }]}>{profile.identity.displayName || t('profiles.defaultName')}</Text>
                      {active ? <Icon color={colors.primary} name="checkmark-circle" size={16} testID="profile-active-marker" /> : null}
                    </View>
                    <Text selectable numberOfLines={1} style={[styles.profileOrigin, { color: colors.textMuted }]}>{mobileControlPlaneProfileConnectionLabel(profile, t)}</Text>
                  </View>
                  <Icon color={colors.textMuted} name="chevron-forward" size={13} />
                </Pressable>
              </View>
            })}
            <View style={[styles.profileDivider, { backgroundColor: colors.border }]} />
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/control-planes/add')}
              style={({ pressed }) => [styles.addRow, pressed && { backgroundColor: colors.surface }]}
            >
              <View style={[styles.addIcon, { backgroundColor: colors.primarySoft }]}> 
                <Icon color={colors.primary} name="add" size={17} />
              </View>
              <Text style={[styles.addRowText, { color: colors.primary }]}>{t('profiles.add')}</Text>
              <Icon color={colors.textMuted} name="chevron-forward" size={13} />
            </Pressable>
          </View>
          <LanguageRow />
          <AppearanceRow />
          <DiagnosticLogsRow />
        </View>
        {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
      </Screen>
    </SafeAreaView>
  );
}

export function ProfilesWelcome({ cloudAccount, onAdd, onOpenCloudAccount }: {
  cloudAccount?: CloudAccountState;
  onAdd: () => void;
  onOpenCloudAccount?: () => void;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();

  return (
    <View style={styles.welcome}>
      <View style={styles.hero}>
        <Image accessibilityIgnoresInvertColors source={require('../assets/icon.png')} style={styles.brandIcon} />
        <Text style={[styles.brandName, { color: colors.text }]}>TaskHandoff</Text>
        <Text accessibilityRole="header" style={[styles.heroTitle, { color: colors.text }]}>{t('profiles.heroTitle')}</Text>
        <Text style={[styles.heroDescription, { color: colors.textMuted }]}>{t('profiles.heroDescription')}</Text>
      </View>

      <View style={styles.guide}>
        <View style={[styles.guideCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <GuideItem colors={colors} icon="lock-closed" title={t('profiles.secureTitle')} description={t('profiles.secureDescription')} />
          <View style={[styles.guideDivider, { backgroundColor: colors.border }]} />
          <GuideItem colors={colors} icon="sync-outline" title={t('profiles.syncTitle')} description={t('profiles.syncDescription')} />
          <View style={[styles.guideDivider, { backgroundColor: colors.border }]} />
          <GuideItem colors={colors} icon="eye-outline" title={t('profiles.controlTitle')} description={t('profiles.controlDescription')} />
        </View>
        <NativeActionButton label={t('profiles.connect')} onPress={onAdd} />
      </View>

      {cloudAccount && onOpenCloudAccount ? <CloudAccountRow cloudAccount={cloudAccount} onPress={onOpenCloudAccount} /> : null}

      <View style={styles.welcomeFooter}>
        <LanguageRow compact />
        <AppearanceRow compact />
        <Text style={[styles.requirement, { color: colors.textMuted }]}>{isMobileTestMode ? t('profiles.requirementTest') : t('profiles.requirement')}</Text>
      </View>
    </View>
  );
}

function CloudAccountRow({ cloudAccount, onPress }: { cloudAccount: CloudAccountState; onPress(): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const loading = cloudAccount.phase === 'loading';
  const signedIn = cloudAccount.phase === 'signed-in';
  const email = signedIn ? cloudAccount.profile?.email : undefined;
  const label = loading ? t('common.loading') : signedIn ? email ?? t('cloudAccount.title') : t('cloudAccount.signIn');
  const detail = loading ? t('cloudAccount.title') : signedIn ? t('cloudAccount.settings') : t('cloudAccount.optional');

  return (
    <Pressable
      accessibilityLabel={loading ? t('common.loading') : signedIn ? t('cloudAccount.settings') : t('cloudAccount.signIn')}
      accessibilityRole="button"
      accessibilityState={{ disabled: loading }}
      disabled={loading}
      onPress={onPress}
      style={({ pressed }) => [styles.accountRow, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.buttonPressed, loading && styles.accountRowDisabled]}
    >
      <View style={[styles.accountAvatar, { backgroundColor: colors.surface }]}>
        {email ? <Text style={[styles.accountInitial, { color: colors.text }]}>{email.slice(0, 1).toUpperCase()}</Text> : <Icon color={colors.textMuted} name="person-outline" size={19} />}
      </View>
      <View style={styles.accountCopy}>
        <Text numberOfLines={1} style={[styles.accountLabel, { color: colors.text }]}>{label}</Text>
        <Text numberOfLines={1} style={[styles.accountDetail, { color: colors.textMuted }]}>{detail}</Text>
      </View>
      <Icon color={colors.textMuted} name="chevron-forward" size={13} />
    </Pressable>
  );
}

function LanguageRow({ compact = false }: { compact?: boolean }) {
  const { colors } = useMobileTheme();
  const { preference, setPreference, t } = useI18n();
  const labels: Record<LocalePreference, string> = { system: t('locale.system'), 'en-US': t('locale.english'), 'zh-CN': t('locale.chinese') };
  const options: OptionMenuOption<LocalePreference>[] = (Object.keys(labels) as LocalePreference[]).map((value) => ({ label: labels[value], value }));
  return <OptionMenu cancelLabel={t('common.cancel')} onSelect={(value) => { void setPreference(value); }} options={options} selectedValue={preference} title={t('locale.language')}>
    {(open) => <Pressable accessibilityRole="button" onPress={open} style={[styles.languageRow, !compact && { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Icon color={colors.textMuted} name="globe-outline" size={18} />
      <Text style={[styles.languageLabel, { color: colors.text }]}>{t('locale.language')}</Text>
      <Text style={[styles.languageValue, { color: colors.textMuted }]}>{labels[preference]}</Text>
      <Icon color={colors.textMuted} name="chevron-forward" size={12} />
    </Pressable>}
  </OptionMenu>;
}

function AppearanceRow({ compact = false }: { compact?: boolean }) {
  const { colors, preference, setPreference } = useMobileTheme();
  const { t } = useI18n();
  const labels: Record<AppearancePreference, string> = { system: t('appearance.system'), light: t('appearance.light'), dark: t('appearance.dark') };
  const options: OptionMenuOption<AppearancePreference>[] = (Object.keys(labels) as AppearancePreference[]).map((value) => ({ label: labels[value], systemImage: value === 'light' ? 'sun.max' : value === 'dark' ? 'moon' : 'circle.lefthalf.filled', value }));
  return <OptionMenu cancelLabel={t('common.cancel')} onSelect={(value) => { void setPreference(value); }} options={options} selectedValue={preference} title={t('appearance.title')}>
    {(open) => <Pressable accessibilityRole="button" onPress={open} style={[styles.languageRow, !compact && { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Icon color={colors.textMuted} name="contrast-outline" size={18} />
      <Text style={[styles.languageLabel, { color: colors.text }]}>{t('appearance.title')}</Text>
      <Text style={[styles.languageValue, { color: colors.textMuted }]}>{labels[preference]}</Text>
      <Icon color={colors.textMuted} name="chevron-forward" size={12} />
    </Pressable>}
  </OptionMenu>;
}

function DiagnosticLogsRow() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const enabled = useSyncExternalStore(subscribeDiagnosticLogs, getDiagnosticLogsEnabled);

  const copyLogs = async () => {
    try {
      const copied = await copyRecentDiagnosticLogs();
      Alert.alert(t('diagnostics.title'), t(copied ? 'diagnostics.copied' : 'diagnostics.empty'));
    } catch {
      Alert.alert(t('diagnostics.title'), t('diagnostics.copyFailed'));
    }
  };

  const clearLogs = () => {
    Alert.alert(t('diagnostics.clearTitle'), t('diagnostics.clearMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('diagnostics.clear'), style: 'destructive', onPress: () => { void clearDiagnosticLogs().then(() => {
        Alert.alert(t('diagnostics.title'), t('diagnostics.cleared'));
      }).catch(() => {
        Alert.alert(t('diagnostics.title'), t('diagnostics.clearFailed'));
      }); } },
    ]);
  };

  return (
    <View style={[styles.diagnosticsCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.diagnosticsHeader}>
        <View style={styles.diagnosticsCopy}>
          <Text style={[styles.diagnosticsLabel, { color: colors.text }]}>{t('diagnostics.enabled')}</Text>
          <Text style={[styles.diagnosticsHelp, { color: colors.textMuted }]}>{t('diagnostics.help')}</Text>
        </View>
        <Switch
          accessibilityLabel={t('diagnostics.enabled')}
          onValueChange={setDiagnosticLogsEnabled}
          testID="diagnostic-logs-toggle"
          trackColor={{ false: colors.border, true: colors.primary }}
          value={enabled}
        />
      </View>
      <View style={[styles.diagnosticsDivider, { backgroundColor: colors.border }]} />
      <Pressable accessibilityRole="button" onPress={() => { void copyLogs(); }} style={({ pressed }) => [styles.diagnosticsAction, pressed && { backgroundColor: colors.surface }]}>
        <Icon color={colors.primary} name="copy-outline" size={18} />
        <Text style={[styles.diagnosticsActionText, { color: colors.primary }]}>{t('diagnostics.copyRecent')}</Text>
      </Pressable>
      <View style={[styles.diagnosticsDivider, { backgroundColor: colors.border }]} />
      <Pressable accessibilityRole="button" onPress={clearLogs} style={({ pressed }) => [styles.diagnosticsAction, pressed && { backgroundColor: colors.surface }]}>
        <Icon color={colors.error} name="trash-outline" size={18} />
        <Text style={[styles.diagnosticsActionText, { color: colors.error }]}>{t('diagnostics.clear')}</Text>
      </Pressable>
    </View>
  );
}

function GuideItem({ colors, icon, title, description }: { colors: ReturnType<typeof useMobileTheme>['colors']; icon: IconName; title: string; description: string }) {
  return (
    <View style={styles.guideItem}>
      <View style={styles.guideIcon}>
        <Icon color={colors.primary} name={icon} size={21} />
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
  guide: { gap: 14 },
  guideCard: { borderRadius: 18, borderWidth: 1, paddingHorizontal: 16 },
  guideItem: { flexDirection: 'row', gap: 12, paddingVertical: 15 },
  guideIcon: { alignItems: 'center', marginTop: 2, width: 24 },
  guideCopy: { flex: 1, gap: 3 },
  guideTitle: { fontSize: 15, fontWeight: '700' },
  guideDescription: { fontSize: 13, lineHeight: 19 },
  guideDivider: { height: StyleSheet.hairlineWidth, marginLeft: 36 },
  welcomeFooter: { gap: 10, marginTop: 'auto' },
  requirement: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  accountRow: { alignItems: 'center', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 11, minHeight: 64, paddingHorizontal: 12, paddingVertical: 9 },
  accountRowDisabled: { opacity: 0.55 },
  accountAvatar: { alignItems: 'center', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  accountInitial: { fontSize: 14, fontWeight: '700' },
  accountCopy: { flex: 1, gap: 2 },
  accountLabel: { fontSize: 16, fontWeight: '600' },
  accountDetail: { fontSize: 13, lineHeight: 18 },
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
  languageRow: { alignItems: 'center', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 48, paddingHorizontal: 14 },
  languageLabel: { flex: 1, fontSize: 15, fontWeight: '600' },
  languageValue: { fontSize: 13 },
  diagnosticsCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  diagnosticsHeader: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  diagnosticsCopy: { flex: 1, gap: 4 },
  diagnosticsLabel: { fontSize: 15, fontWeight: '600' },
  diagnosticsHelp: { fontSize: 12, lineHeight: 17 },
  diagnosticsDivider: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
  diagnosticsAction: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 46, paddingHorizontal: 14 },
  diagnosticsActionText: { fontSize: 14, fontWeight: '600' },
});
