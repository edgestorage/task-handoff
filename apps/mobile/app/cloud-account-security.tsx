import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import { Icon, type IconName } from '../src/components/Icon';
import { Screen } from '../src/components/Screen';
import { NativeActionButton } from '../src/components/NativeActionButton';
import { OneTimeCodeInput } from '../src/components/OneTimeCodeInput';
import { useMobileTheme } from '../src/components/theme';
import { NativeCloudAccountSecurityScreen } from '../src/control-plane/NativeCloudAccountSecurityScreen';
import type { DeviceSession } from '@task-handoff/cloud-contracts/mobile';
import { useCloudAccountSecurity, type CloudAccountSecurityController } from '../src/control-plane/use-cloud-account-security';
import { useI18n } from '../src/i18n';
import type { MessageKey } from '../src/i18n/messages';
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
      <NativeCloudAccountSecurityScreen controller={controller} onOpenControlPlanes={() => router.push('/cloud-control-planes' as never)}/>
    </>;
  }
  return <CloudAccountSecurityForm controller={controller}/>;
}

function CloudAccountSecurityForm({ controller }: { controller: CloudAccountSecurityController }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { busy, currentDeviceId, devices, enrollment, message, profile, recoveryCodes } = controller;

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
          <Divider/>
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
                {current ? null : <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => controller.revokeDevice(device.id)}>
                  <Text style={[styles.rowCommand, { color: colors.error }]}>{t('cloudAccount.revoke')}</Text>
                </Pressable>}
              </View>
            </View>;
          })}
        </SettingsSection> : null}

        <SettingsSection title={t('cloudAccount.totpTitle')}>
          {!enrollment && !recoveryCodes.length ? <>
            {profile?.totpEnabled ? <>
              <FieldRow icon="lock-closed">
                <TextInput
                  accessibilityLabel={t('cloudAccount.stepUpPassword')}
                  editable={!busy}
                  onChangeText={controller.setStepUp}
                  placeholder={t('cloudAccount.stepUpPasswordPlaceholder')}
                  placeholderTextColor={colors.textPlaceholder}
                  secureTextEntry
                  style={[styles.input, { color: colors.text }]}
                  value={controller.stepUp}
                />
              </FieldRow>
              <Divider/>
              <FieldRow icon="lock-closed-outline">
                <TextInput
                  accessibilityLabel={t('cloudAccount.stepUpCode')}
                  autoCapitalize="characters"
                  editable={!busy}
                  onChangeText={controller.setStepCode}
                  placeholder={t('cloudAccount.stepUpCodePlaceholder')}
                  placeholderTextColor={colors.textPlaceholder}
                  style={[styles.input, { color: colors.text }]}
                  value={controller.stepCode}
                />
              </FieldRow>
              <Divider/>
            </> : null}
            <ActionRow
              disabled={busy || Boolean(profile?.totpEnabled && !controller.stepUp)}
              icon="lock-closed-outline"
              label={profile?.totpEnabled ? t('cloudAccount.replaceAuthenticator') : t('cloudAccount.enableAuthenticator')}
              onPress={controller.beginTotp}
            />
            {profile?.totpEnabled ? <>
              <Divider/>
              <ActionRow
                destructive
                disabled={busy || !controller.stepUp}
                icon="lock-open"
                label={t('cloudAccount.disableAuthenticator')}
                onPress={controller.disableTotp}
              />
            </> : null}
          </> : null}
          {enrollment ? <View style={styles.form}>
            <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{t('cloudAccount.totpSecret')}</Text>
            <Text selectable style={[styles.secret, { color: colors.text }]}>{enrollment.secret}</Text>
            <OneTimeCodeInput accessibilityLabel={t('cloudAccount.totpCode')} disabled={busy} onChangeText={controller.setTotpCode} value={controller.totpCode}/>
            <NativeActionButton
              compact
              disabled={busy || controller.totpCode.length !== 6}
              icon="shield-checkmark-outline"
              label={t('cloudAccount.confirmAuthenticator')}
              onPress={controller.confirmTotp}
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
            onPress={controller.signOut}
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

function ValueRow({ color, icon, label, value }: { color?: string; icon: IconName; label: string; value: string }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.row}>
      <RowIcon icon={icon}/>
      <Text style={[styles.rowLabel, styles.grow, { color: colors.text }]}>{label}</Text>
      <Text numberOfLines={1} selectable style={[styles.rowValue, { color: color ?? colors.textMuted }]}>{value}</Text>
    </View>
  );
}

function ActionRow({ destructive = false, disabled = false, icon, label, onPress }: { destructive?: boolean; disabled?: boolean; icon: IconName; label: string; onPress(): void }) {
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
      <Icon color={colors.textMuted} name="chevron-forward" size={12}/>
    </Pressable>
  );
}

function FieldRow({ children, icon }: { children: ReactNode; icon: IconName }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.fieldRow}>
      <Icon color={colors.textMuted} name={icon} size={19}/>
      {children}
    </View>
  );
}

function RowIcon({ icon, tint }: { icon: IconName; tint?: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.rowIcon}><Icon color={tint ?? colors.textMuted} name={icon} size={18}/></View>;
}

const DEVICE_KINDS: Record<DeviceSession['kind'], { icon: IconName; label: MessageKey }> = {
  browser: { icon: 'globe-outline', label: 'cloudAccount.deviceKind.browser' },
  'control-plane': { icon: 'server-outline', label: 'cloudAccount.deviceKind.controlPlane' },
  mobile: { icon: 'phone-portrait-outline', label: 'cloudAccount.deviceKind.mobile' },
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
