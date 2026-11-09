import { Button, Host, HStack, Label, LabeledContent, List, ProgressView, Section, Text } from '@expo/ui/swift-ui';
import {
  buttonStyle,
  disabled as disabledModifier,
  font,
  foregroundStyle,
  lineLimit,
  listStyle,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import type { SFSymbol } from 'expo-symbols';

import type { DeviceSession } from '@task-handoff/cloud-contracts/mobile';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/messages';
import type { NativeCloudAccountSecurityActionsScreenProps } from './NativeCloudAccountSecurityActionsScreen';

const DEVICE_KINDS: Record<DeviceSession['kind'], { icon: SFSymbol; label: MessageKey }> = {
  browser: { icon: 'globe', label: 'cloudAccount.deviceKind.browser' },
  'control-plane': { icon: 'server.rack', label: 'cloudAccount.deviceKind.controlPlane' },
  mobile: { icon: 'iphone', label: 'cloudAccount.deviceKind.mobile' },
};

export function NativeCloudAccountSecurityActionsScreen({ controller, onOpenDelete, onOpenTwoStep }: NativeCloudAccountSecurityActionsScreenProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const { busy, message, profile } = controller;
  const enabled = Boolean(profile?.totpEnabled);

  return (
    <View style={{ flex: 1 }}>
      <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ flex: 1 }}>
        <List modifiers={[listStyle('insetGrouped'), tint(colors.primary)]}>
          {!controller.loaded ? (
            <Section>
              <HStack spacing={10}>
                <ProgressView testID="cloud-account-loading"/>
                <Text modifiers={[foregroundStyle('secondary')]}>{t('cloudAccount.loadingProfile')}</Text>
              </HStack>
            </Section>
          ) : null}

          {message ? (
            <Section>
              <Label title={message} systemImage="exclamationmark.triangle.fill" modifiers={[foregroundStyle(colors.error)]}/>
            </Section>
          ) : null}

          {controller.loaded ? <>
            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>
                {t(enabled ? 'cloudAccount.twoStepEnabled' : 'cloudAccount.twoStepDisabled')} · {t(enabled ? 'cloudAccount.twoStepEnabledDescription' : 'cloudAccount.twoStepDisabledDescription')}
              </Text>}
            >
              <Button
                label={t('cloudAccount.totpTitle')}
                systemImage={enabled ? 'checkmark.shield.fill' : 'shield'}
                onPress={onOpenTwoStep}
                modifiers={[disabledModifier(busy)]}
              />
            </Section>

            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.devicesHelp')}</Text>}
              title={t('cloudAccount.devices')}
            >
              {controller.devices.length ? controller.devices.map((device) => {
                const current = device.id === controller.currentDeviceId;
                const kind = DEVICE_KINDS[device.kind];
                return (
                  <LabeledContent key={device.id} label={<Label title={device.deviceName || device.id} systemImage={kind.icon}/>}>
                    {current ? (
                      <Text modifiers={[font({ size: 13 }), foregroundStyle(colors.sessionActive), lineLimit(1)]}>{t('cloudAccount.thisDevice')}</Text>
                    ) : (
                      <Button
                        label={t('cloudAccount.revoke')}
                        role="destructive"
                        onPress={() => controller.revokeDevice(device.id)}
                        modifiers={[buttonStyle('borderless'), disabledModifier(busy)]}
                      />
                    )}
                  </LabeledContent>
                );
              }) : <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.noDevices')}</Text>}
            </Section>

            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.deleteAccountHelp')}</Text>}
            >
              <Button
                label={t('cloudAccount.deleteAccountTitle')}
                role="destructive"
                systemImage="trash"
                onPress={onOpenDelete}
                modifiers={[disabledModifier(busy)]}
              />
            </Section>
          </> : null}
        </List>
      </Host>
    </View>
  );
}
