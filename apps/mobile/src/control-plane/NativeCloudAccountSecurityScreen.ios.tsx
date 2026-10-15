import { Button, Host, Label, LabeledContent, List, Section, SecureField, Text, TextField } from '@expo/ui/swift-ui';
import {
  buttonStyle,
  disabled as disabledModifier,
  font,
  foregroundStyle,
  keyboardType,
  lineLimit,
  listStyle,
  scrollDismissesKeyboard,
  submitLabel,
  textSelection,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import { router } from 'expo-router';
import type { SFSymbol } from 'expo-symbols';

import type { DeviceSession } from '@task-handoff/cloud-contracts/mobile';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/messages';
import type { NativeCloudAccountSecurityScreenProps } from './NativeCloudAccountSecurityScreen';

const DEVICE_KINDS: Record<DeviceSession['kind'], { icon: SFSymbol; label: MessageKey }> = {
  browser: { icon: 'globe', label: 'cloudAccount.deviceKind.browser' },
  'control-plane': { icon: 'server.rack', label: 'cloudAccount.deviceKind.controlPlane' },
  mobile: { icon: 'iphone', label: 'cloudAccount.deviceKind.mobile' },
};

export function NativeCloudAccountSecurityScreen({ controller }: NativeCloudAccountSecurityScreenProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const { busy, currentDeviceId, devices, enrollment, message, profile, recoveryCodes } = controller;
  const secondaryText = [font({ size: 13 }), foregroundStyle('secondary'), lineLimit(1)];

  return (
    <View style={{ flex: 1 }}>
      <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ flex: 1 }}>
        <List modifiers={[listStyle('insetGrouped'), tint(colors.primary), scrollDismissesKeyboard('interactively')]}>
          {!controller.loaded ? (
            <Section>
              <Label title={t('cloudAccount.loadingProfile')} systemImage="arrow.triangle.2.circlepath" />
            </Section>
          ) : null}

          {message ? (
            <Section>
              <Label title={message} systemImage="exclamationmark.triangle.fill" modifiers={[foregroundStyle(colors.error)]} />
            </Section>
          ) : null}

          {controller.loaded ? <>
            <Section title={t('cloudAccount.accountInformation')}>
              <ValueRow icon="envelope" label={t('cloudAccount.email')} modifiers={secondaryText} value={profile?.email ?? '—'} />
              <LabeledContent label={<Label title={t('cloudAccount.emailStatus')} systemImage="checkmark.shield" />}>
                <Text modifiers={[font({ size: 13 }), foregroundStyle(profile?.emailVerified ? colors.sessionActive : 'secondary')]}>
                  {profile?.emailVerified ? t('cloudAccount.emailVerified') : t('cloudAccount.emailPending')}
                </Text>
              </LabeledContent>
            </Section>

            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.cloudControlPlanesHelp')}</Text>}
              title={t('cloudAccount.cloudControlPlanes')}
            >
              <Button
                label={t('cloudAccount.manageControlPlanes')}
                systemImage="server.rack"
                onPress={() => router.push('/cloud-control-planes' as never)}
              />
            </Section>

            {devices.length ? (
              <Section title={t('cloudAccount.devices')}>
                {devices.map((device) => {
                  const current = device.id === currentDeviceId;
                  const kind = DEVICE_KINDS[device.kind];
                  const detail = [t(kind.label), current ? t('cloudAccount.thisDevice') : undefined].filter(Boolean).join(' · ');
                  return (
                    <LabeledContent key={device.id} label={<Label title={device.deviceName || device.id} systemImage={kind.icon} />}>
                      {current ? (
                        <Text modifiers={[font({ size: 13 }), foregroundStyle('secondary'), lineLimit(1)]}>{detail}</Text>
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
                })}
              </Section>
            ) : null}

            <Section title={t('cloudAccount.totpTitle')}>
              {!enrollment && !recoveryCodes.length ? <>
                {profile?.totpEnabled ? <>
                  <SecureField
                    onTextChange={controller.setStepUp}
                    placeholder={t('cloudAccount.stepUpPasswordPlaceholder')}
                  />
                  <TextField
                    onTextChange={controller.setStepCode}
                    placeholder={t('cloudAccount.stepUpCodePlaceholder')}
                  />
                </> : null}
                <Button
                  label={profile?.totpEnabled ? t('cloudAccount.replaceAuthenticator') : t('cloudAccount.enableAuthenticator')}
                  systemImage="lock.shield"
                  onPress={controller.beginTotp}
                  modifiers={[disabledModifier(busy || Boolean(profile?.totpEnabled && !controller.stepUp))]}
                />
                {profile?.totpEnabled ? (
                  <Button
                    label={t('cloudAccount.disableAuthenticator')}
                    role="destructive"
                    systemImage="lock.open"
                    onPress={controller.disableTotp}
                    modifiers={[disabledModifier(busy || !controller.stepUp)]}
                  />
                ) : null}
              </> : null}
              {enrollment ? <>
                <Text modifiers={[font({ size: 13 }), foregroundStyle('secondary')]}>{t('cloudAccount.totpSecret')}</Text>
                <Text modifiers={[font({ design: 'monospaced', size: 13 }), textSelection(true)]}>{enrollment.secret}</Text>
                <TextField
                  onTextChange={controller.setTotpCode}
                  placeholder={t('cloudAccount.totpCode')}
                  modifiers={[keyboardType('numeric'), submitLabel('done')]}
                />
                <Button
                  label={t('cloudAccount.confirmAuthenticator')}
                  systemImage="checkmark.shield"
                  onPress={controller.confirmTotp}
                  modifiers={[disabledModifier(busy || controller.totpCode.length !== 6)]}
                />
              </> : null}
              {recoveryCodes.length ? <>
                <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.recoveryCodesHelp')}</Text>
                <Text modifiers={[font({ design: 'monospaced', size: 13 }), textSelection(true)]}>{recoveryCodes.join('\n')}</Text>
              </> : null}
            </Section>

            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.signOutHelp')}</Text>}
            >
              <Button
                label={t('cloudAccount.signOutAction')}
                role="destructive"
                onPress={controller.signOut}
                modifiers={[disabledModifier(busy)]}
              />
            </Section>
          </> : null}
        </List>
      </Host>
    </View>
  );
}

function ValueRow({ icon, label, modifiers, value }: {
  icon: SFSymbol;
  label: string;
  modifiers: NonNullable<Parameters<typeof Text>[0]['modifiers']>;
  value: string;
}) {
  return (
    <LabeledContent label={<Label title={label} systemImage={icon} />}>
      <Text modifiers={[...modifiers, textSelection(true)]}>{value}</Text>
    </LabeledContent>
  );
}
