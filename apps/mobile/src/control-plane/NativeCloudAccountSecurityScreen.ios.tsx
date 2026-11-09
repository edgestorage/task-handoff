import { Button, Host, HStack, Label, LabeledContent, List, ProgressView, Section, Text } from '@expo/ui/swift-ui';
import {
  disabled as disabledModifier,
  font,
  foregroundStyle,
  lineLimit,
  listStyle,
  textSelection,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import type { SFSymbol } from 'expo-symbols';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { NativeCloudAccountSecurityScreenProps } from './NativeCloudAccountSecurityScreen';

export function NativeCloudAccountSecurityScreen({ controller, onOpenControlPlanes, onOpenSecurityActions }: NativeCloudAccountSecurityScreenProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const { busy, message, profile } = controller;
  const secondaryText = [font({ size: 13 }), foregroundStyle('secondary'), lineLimit(1)];

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
                onPress={onOpenControlPlanes}
              />
            </Section>

            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.securityActionsHelp')}</Text>}
              title={t('cloudAccount.securityActionsTitle')}
            >
              <Button
                label={t('cloudAccount.manageSecurityActions')}
                systemImage={profile?.totpEnabled ? 'lock.shield' : 'lock.open'}
                onPress={onOpenSecurityActions}
                modifiers={[disabledModifier(busy)]}
              />
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
