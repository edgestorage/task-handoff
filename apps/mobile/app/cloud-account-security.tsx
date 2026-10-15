import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';

import type { AccountPublicProfile, DeviceSession, OfficialMobileAccountClient, TotpEnrollmentResponse } from '@task-handoff/cloud-contracts/mobile';

import { NativeActionButton } from '../src/components/NativeActionButton';
import { OneTimeCodeInput } from '../src/components/OneTimeCodeInput';
import { Screen } from '../src/components/Screen';
import { SystemIcon } from '../src/components/SystemIcon';
import { useMobileTheme } from '../src/components/theme';
import { cloudMobileErrorMessage } from '../src/control-plane/cloud-error';
import { hasActiveCloudAccount, logoutActiveCloudAccount, restoreActiveCloudAccountSession } from '../src/control-plane/runtime';
import { useI18n } from '../src/i18n';
import type { MessageKey } from '../src/i18n/messages';
import { isMobileFeatureEnabled } from '../src/platform/build-variant';

type Icon = { android: AndroidSymbol; ios: SFSymbol };
type CloudAccountClient = OfficialMobileAccountClient;

export default function CloudAccountSecurityScreen() {
  if (!isMobileFeatureEnabled('officialAccount')) return <Redirect href="/profiles" />;
  return <CloudAccountSecurityContent />;
}

function CloudAccountSecurityContent() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const zh = locale === 'zh-CN';
  const [profile, setProfile] = useState<AccountPublicProfile>();
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string>();
  const [stepUp, setStepUp] = useState('');
  const [stepCode, setStepCode] = useState('');
  const [enrollment, setEnrollment] = useState<TotpEnrollmentResponse>();
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const load = useCallback(async () => {
    try {
      const session = await restoreActiveCloudAccountSession();
      setCurrentDeviceId(session.reference().id);
      // A projection this app version cannot read (for example a device kind added by a
      // newer cloud service) must not hide the projections that did load, so the two
      // account reads settle independently.
      const [profileResult, devicesResult] = await Promise.allSettled([session.client.profile(), session.client.devices()]);
      if (profileResult.status === 'fulfilled') setProfile(profileResult.value);
      if (devicesResult.status === 'fulfilled') setDevices(devicesResult.value);
      const failure = profileResult.status === 'rejected' ? profileResult.reason : devicesResult.status === 'rejected' ? devicesResult.reason : undefined;
      setMessage(failure ? cloudMobileErrorMessage(failure, zh) : undefined);
    } catch (error) {
      setMessage(cloudMobileErrorMessage(error, zh));
    }
  }, [zh]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function stepUpToken(client: CloudAccountClient) {
    return client.stepUp({ password: stepUp, ...(stepCode.includes('-') ? { recoveryCode: stepCode } : stepCode ? { totpCode: stepCode } : {}) });
  }

  async function action(operation: (client: CloudAccountClient) => Promise<unknown>, done?: (result: unknown) => void) {
    setBusy(true);
    setMessage(undefined);
    try {
      const session = await restoreActiveCloudAccountSession();
      const result = await operation(session.client);
      done?.(result);
      await load();
    } catch (error) {
      setMessage(cloudMobileErrorMessage(error, zh));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setMessage(undefined);
    try {
      await logoutActiveCloudAccount();
      router.back();
    } catch (error) {
      if (!await hasActiveCloudAccount().catch(() => false)) router.back();
      else setMessage(cloudMobileErrorMessage(error, zh));
    } finally {
      setBusy(false);
    }
  }

  function confirmLogout() {
    Alert.alert(t('cloudAccount.signOutTitle'), t('cloudAccount.signOutDescription'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('cloudAccount.signOutConfirm'), style: 'destructive', onPress: () => void logout() },
    ]);
  }

  return <>
    <Stack.Screen options={{ title: t('cloudAccount.settings') }}/>
    <Screen>
      {!profile && !message ? (
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
          <ValueRow icon={{ android: 'mail', ios: 'envelope' }} label={t('cloudAccount.email')} value={profile?.email ?? '—'}/>
          <Divider/>
          <ValueRow
            color={profile?.emailVerified ? colors.sessionActive : colors.textMuted}
            icon={{ android: 'verified_user', ios: 'checkmark.shield' }}
            label={t('cloudAccount.emailStatus')}
            value={profile?.emailVerified ? t('cloudAccount.emailVerified') : t('cloudAccount.emailPending')}
          />
        </SettingsSection>

        <SettingsSection footer={t('cloudAccount.cloudControlPlanesHelp')} title={t('cloudAccount.cloudControlPlanes')}>
          <ActionRow icon={{ android: 'dns', ios: 'server.rack' }} label={t('cloudAccount.manageControlPlanes')} onPress={() => router.push('/cloud-control-planes' as never)}/>
        </SettingsSection>

        {devices.length ? <SettingsSection title={t('cloudAccount.devices')}>
          {devices.map((device, index) => {
            const current = device.id === currentDeviceId;
            const kind = deviceKind(device.kind);
            const detail = [t(kind.label), current ? t('cloudAccount.thisDevice') : undefined].filter(Boolean).join(' · ');
            return <View key={device.id}>
              {index ? <Divider/> : null}
              <View style={styles.row}>
                <RowIcon icon={kind.icon}/>
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={[styles.rowLabel, { color: colors.text }]}>{device.deviceName || device.id}</Text>
                  <Text numberOfLines={1} style={[styles.rowDetail, { color: colors.textMuted }]}>{detail}</Text>
                </View>
                {current ? null : <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => void action((client) => client.revokeDevice(device.id))}>
                  <Text style={[styles.rowCommand, { color: colors.error }]}>{t('cloudAccount.revoke')}</Text>
                </Pressable>}
              </View>
            </View>;
          })}
        </SettingsSection> : null}

        <SettingsSection title={t('cloudAccount.totpTitle')}>
          {!enrollment && !recoveryCodes.length ? <>
            {profile?.totpEnabled ? <>
              <FieldRow icon={{ android: 'lock', ios: 'lock' }}>
                <TextInput
                  accessibilityLabel={t('cloudAccount.stepUpPassword')}
                  editable={!busy}
                  onChangeText={setStepUp}
                  placeholder={t('cloudAccount.stepUpPasswordPlaceholder')}
                  placeholderTextColor={colors.textPlaceholder}
                  secureTextEntry
                  style={[styles.input, { color: colors.text }]}
                  value={stepUp}
                />
              </FieldRow>
              <Divider/>
              <FieldRow icon={{ android: 'shield_lock', ios: 'lock.shield' }}>
                <TextInput
                  accessibilityLabel={t('cloudAccount.stepUpCode')}
                  autoCapitalize="characters"
                  editable={!busy}
                  onChangeText={setStepCode}
                  placeholder={t('cloudAccount.stepUpCodePlaceholder')}
                  placeholderTextColor={colors.textPlaceholder}
                  style={[styles.input, { color: colors.text }]}
                  value={stepCode}
                />
              </FieldRow>
              <Divider/>
            </> : null}
            <ActionRow
              disabled={busy || Boolean(profile?.totpEnabled && !stepUp)}
              icon={{ android: 'shield_lock', ios: 'lock.shield' }}
              label={profile?.totpEnabled ? t('cloudAccount.replaceAuthenticator') : t('cloudAccount.enableAuthenticator')}
              onPress={() => void action(
                async (client) => client.beginTotp(profile?.totpEnabled ? { replace: true, stepUp: await stepUpToken(client) } : {}),
                (result) => setEnrollment(result as TotpEnrollmentResponse),
              )}
            />
            {profile?.totpEnabled ? <>
              <Divider/>
              <ActionRow
                destructive
                disabled={busy || !stepUp}
                icon={{ android: 'lock_open', ios: 'lock.open' }}
                label={t('cloudAccount.disableAuthenticator')}
                onPress={() => void action(async (client) => client.disableTotp({ stepUp: await stepUpToken(client) }))}
              />
            </> : null}
          </> : null}
          {enrollment ? <View style={styles.form}>
            <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{t('cloudAccount.totpSecret')}</Text>
            <Text selectable style={[styles.secret, { color: colors.text }]}>{enrollment.secret}</Text>
            <OneTimeCodeInput accessibilityLabel={t('cloudAccount.totpCode')} disabled={busy} onChangeText={setTotpCode} value={totpCode}/>
            <NativeActionButton
              compact
              disabled={busy || totpCode.length !== 6}
              icon={{ android: 'verified_user', ios: 'checkmark.shield' }}
              label={t('cloudAccount.confirmAuthenticator')}
              onPress={() => void action(
                (client) => client.confirmTotp({ enrollmentToken: enrollment.enrollmentToken, code: totpCode }),
                (result) => { setRecoveryCodes((result as { recoveryCodes?: string[] })?.recoveryCodes ?? []); setEnrollment(undefined); },
              )}
            />
          </View> : null}
          {recoveryCodes.length ? <View style={styles.form}>
            <Text style={[styles.rowDetail, { color: colors.textMuted }]}>{t('cloudAccount.recoveryCodesHelp')}</Text>
            <Text selectable style={[styles.secret, { color: colors.text }]}>{recoveryCodes.join('\n')}</Text>
          </View> : null}
        </SettingsSection>

        <SettingsSection footer={t('cloudAccount.signOutHelp')}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={confirmLogout}
            style={({ pressed }) => [styles.signOutRow, busy && styles.disabled, pressed && { backgroundColor: colors.surfaceMuted }]}
          >
            <Text style={[styles.signOutLabel, { color: colors.error }]}>{t('cloudAccount.signOutAction')}</Text>
          </Pressable>
        </SettingsSection>
      </>}
    </Screen>
  </>;
}

function SettingsSection({ children, footer, title }: { children: ReactNode; footer?: string; title?: string }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.section}>
      {title ? <Text accessibilityRole="header" style={[styles.sectionLabel, { color: colors.textMuted }]}>{title}</Text> : null}
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>
      {footer ? <Text style={[styles.footnote, { color: colors.textMuted }]}>{footer}</Text> : null}
    </View>
  );
}

function ValueRow({ color, icon, label, value }: { color?: string; icon: Icon; label: string; value: string }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.row}>
      <RowIcon icon={icon}/>
      <Text style={[styles.rowLabel, styles.grow, { color: colors.text }]}>{label}</Text>
      <Text numberOfLines={1} selectable style={[styles.rowValue, { color: color ?? colors.textMuted }]}>{value}</Text>
    </View>
  );
}

function ActionRow({ destructive = false, disabled = false, icon, label, onPress }: { destructive?: boolean; disabled?: boolean; icon: Icon; label: string; onPress(): void }) {
  const { colors } = useMobileTheme();
  const tint = disabled ? colors.textMuted : destructive ? colors.error : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && !disabled && { backgroundColor: colors.surfaceMuted }]}
    >
      <RowIcon icon={icon} tint={tint}/>
      <Text style={[styles.rowLabel, styles.grow, { color: tint }]}>{label}</Text>
      <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={12}/>
    </Pressable>
  );
}

function FieldRow({ children, icon }: { children: ReactNode; icon: Icon }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.fieldRow}>
      <SystemIcon android={icon.android} color={colors.textMuted} ios={icon.ios} size={19}/>
      {children}
    </View>
  );
}

function RowIcon({ icon, tint }: { icon: Icon; tint?: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.rowIcon}><SystemIcon android={icon.android} color={tint ?? colors.textMuted} ios={icon.ios} size={18}/></View>;
}

const DEVICE_KINDS: Record<DeviceSession['kind'], { icon: Icon; label: MessageKey }> = {
  browser: { icon: { android: 'language', ios: 'globe' }, label: 'cloudAccount.deviceKind.browser' },
  'control-plane': { icon: { android: 'dns', ios: 'server.rack' }, label: 'cloudAccount.deviceKind.controlPlane' },
  mobile: { icon: { android: 'smartphone', ios: 'smartphone' }, label: 'cloudAccount.deviceKind.mobile' },
};

function deviceKind(kind: DeviceSession['kind']) { return DEVICE_KINDS[kind]; }

function Divider() {
  const { colors } = useMobileTheme();
  return <View style={[styles.divider, { backgroundColor: colors.border }]}/>;
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', flexGrow: 1, gap: 10, justifyContent: 'center' },
  loadingText: { fontSize: 13 },
  heading: { gap: 3, paddingTop: 2 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.4 },
  description: { fontSize: 13, lineHeight: 18 },
  section: { gap: 7 },
  sectionLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.4, marginLeft: 14 },
  group: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 45 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 11, minHeight: 52, paddingHorizontal: 14 },
  rowIcon: { alignItems: 'center', width: 20 },
  rowCopy: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  grow: { flex: 1 },
  rowDetail: { fontSize: 12, lineHeight: 17 },
  rowValue: { flexShrink: 1, fontSize: 13, textAlign: 'right' },
  rowCommand: { fontSize: 15, fontWeight: '600' },
  fieldRow: { alignItems: 'center', flexDirection: 'row', gap: 11, minHeight: 52, paddingHorizontal: 14 },
  input: { flex: 1, fontSize: 15, minHeight: 50, paddingVertical: 10 },
  form: { gap: 10, padding: 14 },
  fieldLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.4 },
  secret: { fontFamily: 'monospace', fontSize: 13, lineHeight: 20 },
  footnote: { fontSize: 12, lineHeight: 17, marginHorizontal: 14 },
  message: { fontSize: 13, lineHeight: 19, marginHorizontal: 14 },
  signOutRow: { alignItems: 'center', justifyContent: 'center', minHeight: 52, paddingHorizontal: 14 },
  signOutLabel: { fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
