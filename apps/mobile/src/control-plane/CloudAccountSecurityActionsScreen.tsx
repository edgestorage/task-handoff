import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { DeviceSession } from '@task-handoff/cloud-contracts/mobile';

import { type IconName } from '../components/Icon';
import { Screen } from '../components/Screen';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/messages';
import { ActionRow, FieldRow, SettingsDivider, SettingsSection, TrailingActionRow } from './CloudAccountSettingsUI';
import type { CloudAccountSecurityController } from './use-cloud-account-security';

type Props = {
  controller: CloudAccountSecurityController;
  onOpenDelete(): void;
  onOpenTwoStep(): void;
};

const DEVICE_KINDS: Record<DeviceSession['kind'], { icon: IconName; label: MessageKey }> = {
  browser: { icon: 'globe-outline', label: 'cloudAccount.deviceKind.browser' },
  'control-plane': { icon: 'server-outline', label: 'cloudAccount.deviceKind.controlPlane' },
  mobile: { icon: 'phone-portrait-outline', label: 'cloudAccount.deviceKind.mobile' },
};

export function CloudAccountSecurityActionsScreen({ controller, onOpenDelete, onOpenTwoStep }: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();

  if (!controller.loaded) {
    return <Screen>
      <View style={styles.loading}>
        <ActivityIndicator accessibilityLabel={t('cloudAccount.loadingProfile')}/>
        <Text style={[styles.loadingText, { color: colors.textMuted }]}>{t('cloudAccount.loadingProfile')}</Text>
      </View>
    </Screen>;
  }

  const enabled = Boolean(controller.profile?.totpEnabled);

  return <Screen testID="cloud-account-security-actions-screen">
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('cloudAccount.securityActionsTitle')}</Text>
      {controller.profile?.email ? <Text style={[styles.description, { color: colors.textMuted }]}>{controller.profile.email}</Text> : null}
    </View>

    {controller.message ? <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.error }]}>{controller.message}</Text> : null}

    <SettingsSection footer={t('cloudAccount.twoStepHelp')} testID="two-step-verification-entry-section">
      <ActionRow
        detail={t(enabled ? 'cloudAccount.twoStepEnabled' : 'cloudAccount.twoStepDisabled')}
        icon={enabled ? 'shield-checkmark-outline' : 'shield-outline'}
        label={t('cloudAccount.totpTitle')}
        onPress={onOpenTwoStep}
      />
    </SettingsSection>

    <DevicesSection controller={controller}/>

    <SettingsSection footer={t('cloudAccount.deleteAccountHelp')} testID="account-deletion-entry-section">
      <ActionRow
        destructive
        detail={t('cloudAccount.deleteAccountEntryDescription')}
        icon="trash-outline"
        label={t('cloudAccount.deleteAccountTitle')}
        onPress={onOpenDelete}
      />
    </SettingsSection>
  </Screen>;
}

function DevicesSection({ controller }: { controller: CloudAccountSecurityController }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();

  return <SettingsSection footer={t('cloudAccount.devicesHelp')} testID="signed-in-devices-section" title={t('cloudAccount.devices')}>
    {controller.devices.length ? controller.devices.map((device, index) => {
      const current = device.id === controller.currentDeviceId;
      const kind = DEVICE_KINDS[device.kind];
      const name = device.deviceName || device.id;
      return <View key={device.id}>
        {index ? <SettingsDivider/> : null}
        {current ? (
          <FieldRow icon={kind.icon}>
            <Text style={[styles.deviceName, { color: colors.text }]}>{name}</Text>
            <Text style={[styles.deviceDetail, { color: colors.sessionActive }]}>{t('cloudAccount.thisDevice')}</Text>
          </FieldRow>
        ) : <TrailingActionRow
          accessibilityLabel={`${t('cloudAccount.revoke')} ${name}`}
          actionLabel={t('cloudAccount.revoke')}
          destructive
          detail={t(kind.label)}
          disabled={controller.busy}
          icon={kind.icon}
          label={name}
          onAction={() => controller.revokeDevice(device.id)}
        />}
      </View>;
    }) : <View style={styles.emptyDevices}>
      <Text style={[styles.emptyDevicesText, { color: colors.textMuted }]}>{t('cloudAccount.noDevices')}</Text>
    </View>}
  </SettingsSection>;
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', flexGrow: 1, gap: 10, justifyContent: 'center' },
  loadingText: { fontSize: 13 },
  heading: { gap: 3, paddingTop: 2 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.4 },
  description: { fontSize: 13, lineHeight: 18 },
  message: { fontSize: 13, lineHeight: 19, marginHorizontal: 14 },
  deviceName: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  deviceDetail: { fontSize: 12, lineHeight: 17 },
  emptyDevices: { alignItems: 'center', justifyContent: 'center', minHeight: 52, paddingHorizontal: 14 },
  emptyDevicesText: { fontSize: 13, lineHeight: 18 },
});
