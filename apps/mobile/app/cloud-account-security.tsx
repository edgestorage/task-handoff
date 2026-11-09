import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import { Screen } from '../src/components/Screen';
import { useMobileTheme } from '../src/components/theme';
import { ActionRow, SettingsDivider, SettingsSection, ValueRow } from '../src/control-plane/CloudAccountSettingsUI';
import { NativeCloudAccountSecurityScreen } from '../src/control-plane/NativeCloudAccountSecurityScreen';
import { useCloudAccountSecurity, type CloudAccountSecurityController } from '../src/control-plane/use-cloud-account-security';
import { useI18n } from '../src/i18n';
import { isMobileFeatureEnabled } from '../src/platform/build-variant';

export default function CloudAccountSecurityScreen() {
  if (!isMobileFeatureEnabled('officialAccount')) return <Redirect href="/profiles" />;
  return <CloudAccountSecurityContent />;
}

function CloudAccountSecurityContent() {
  const { t } = useI18n();
  const controller = useCloudAccountSecurity();

  if (Platform.OS === 'ios') {
    return <>
      <Stack.Screen options={{ title: t('cloudAccount.settings') }}/>
      <NativeCloudAccountSecurityScreen
        controller={controller}
        onOpenControlPlanes={() => router.push('/cloud-control-planes' as never)}
        onOpenSecurityActions={() => router.push('/cloud-account-security-actions' as never)}
      />
    </>;
  }
  return <CloudAccountSecurityForm controller={controller}/>;
}

function CloudAccountSecurityForm({ controller }: { controller: CloudAccountSecurityController }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { busy, message, profile } = controller;

  return <>
    <Stack.Screen options={{ title: t('cloudAccount.settings') }}/>
    <Screen>
      {!controller.loaded ? (
        <View style={styles.loading}>
          <ActivityIndicator accessibilityLabel={t('cloudAccount.loadingProfile')}/>
          <Text style={[styles.loadingText, { color: colors.textMuted }]}>{t('cloudAccount.loadingProfile')}</Text>
        </View>
      ) : <>
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('cloudAccount.title')}</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>{profile?.email ?? t('cloudAccount.loadingProfile')}</Text>
        </View>

        {message ? <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.error }]}>{message}</Text> : null}

        <SettingsSection title={t('cloudAccount.accountInformation')}>
          <ValueRow icon="mail-outline" label={t('cloudAccount.email')} value={profile?.email ?? '—'}/>
          <SettingsDivider/>
          <ValueRow
            color={profile?.emailVerified ? colors.sessionActive : colors.textMuted}
            icon="shield-checkmark-outline"
            label={t('cloudAccount.emailStatus')}
            value={profile?.emailVerified ? t('cloudAccount.emailVerified') : t('cloudAccount.emailPending')}
          />
        </SettingsSection>

        <SettingsSection footer={t('cloudAccount.cloudControlPlanesHelp')} title={t('cloudAccount.cloudControlPlanes')}>
          <ActionRow icon="server-outline" label={t('cloudAccount.manageControlPlanes')} onPress={() => router.push('/cloud-control-planes' as never)}/>
        </SettingsSection>

        <SettingsSection footer={t('cloudAccount.securityActionsHelp')} title={t('cloudAccount.securityActionsTitle')}>
          <ActionRow
            detail={t(profile?.totpEnabled ? 'cloudAccount.twoStepEnabled' : 'cloudAccount.twoStepDisabled')}
            icon="shield-checkmark-outline"
            label={t('cloudAccount.manageSecurityActions')}
            onPress={() => router.push('/cloud-account-security-actions' as never)}
          />
        </SettingsSection>

        <SettingsSection footer={t('cloudAccount.signOutHelp')}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={controller.signOut}
            style={({ pressed }) => [styles.signOutRow, busy && styles.disabled, pressed && { backgroundColor: colors.surface }]}
          >
            <Text style={[styles.signOutLabel, { color: colors.error }]}>{t('cloudAccount.signOutAction')}</Text>
          </Pressable>
        </SettingsSection>

      </>}
    </Screen>
  </>;
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', flexGrow: 1, gap: 10, justifyContent: 'center' },
  loadingText: { fontSize: 13 },
  heading: { gap: 3, paddingTop: 2 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.4 },
  description: { fontSize: 13, lineHeight: 18 },
  message: { fontSize: 13, lineHeight: 19, marginHorizontal: 14 },
  signOutRow: { alignItems: 'center', justifyContent: 'center', minHeight: 52, paddingHorizontal: 14 },
  signOutLabel: { fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
