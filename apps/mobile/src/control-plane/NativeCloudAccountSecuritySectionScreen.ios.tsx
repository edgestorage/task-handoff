import { useEffect, useRef } from 'react';
import {
  Button,
  Host,
  HStack,
  Label,
  List,
  ProgressView,
  RNHostView,
  Section,
  SecureField,
  Text,
  TextField,
  type SecureFieldRef,
  type TextFieldRef,
} from '@expo/ui/swift-ui';
import {
  disabled as disabledModifier,
  font,
  foregroundStyle,
  listStyle,
  scrollDismissesKeyboard,
  textInputAutocapitalization,
  textSelection,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';

import { normalizeSecondFactorCode } from '../components/recovery-code';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { NativeCloudAccountSecuritySectionScreenProps } from './NativeCloudAccountSecuritySectionScreen';
import { TotpEnrollmentPanel } from './TotpEnrollmentPanel';

export function NativeCloudAccountSecuritySectionScreen({ controller, onDeleted, section }: NativeCloudAccountSecuritySectionScreenProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const { busy, message, profile } = controller;
  const enabled = Boolean(profile?.totpEnabled);
  const canDelete = !busy
    && Boolean(controller.deletePassword)
    && (!enabled || Boolean(controller.deleteCode));
  const stepUpInput = useRef<SecureFieldRef>(null);
  const stepCodeInput = useRef<TextFieldRef>(null);
  const deletePasswordInput = useRef<SecureFieldRef>(null);
  const deleteCodeInput = useRef<TextFieldRef>(null);
  const lastStepUp = useRef(controller.stepUp);
  const lastStepCode = useRef(controller.stepCode);
  const lastDeletePassword = useRef(controller.deletePassword);
  const lastDeleteCode = useRef(controller.deleteCode);

  useEffect(() => {
    if (controller.stepUp === lastStepUp.current) return;
    lastStepUp.current = controller.stepUp;
    void stepUpInput.current?.setText(controller.stepUp);
  }, [controller.stepUp]);

  useEffect(() => {
    if (controller.stepCode === lastStepCode.current) return;
    lastStepCode.current = controller.stepCode;
    void stepCodeInput.current?.setText(controller.stepCode);
  }, [controller.stepCode]);

  useEffect(() => {
    if (controller.deletePassword === lastDeletePassword.current) return;
    lastDeletePassword.current = controller.deletePassword;
    void deletePasswordInput.current?.setText(controller.deletePassword);
  }, [controller.deletePassword]);

  useEffect(() => {
    if (controller.deleteCode === lastDeleteCode.current) return;
    lastDeleteCode.current = controller.deleteCode;
    void deleteCodeInput.current?.setText(controller.deleteCode);
  }, [controller.deleteCode]);

  return (
    <View style={{ flex: 1 }}>
      <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ flex: 1 }}>
        <List modifiers={[listStyle('insetGrouped'), tint(colors.primary), scrollDismissesKeyboard('interactively')]}>
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

          {section === 'delete' && controller.loaded && controller.deleteComplete ? (
            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.deleteAccountScheduledDescription')}</Text>}
              title={t('cloudAccount.deleteAccountScheduledTitle')}
            >
              <Button label={t('common.confirm')} systemImage="checkmark.circle" onPress={onDeleted ?? (() => undefined)}/>
            </Section>
          ) : null}

          {section === 'delete' && controller.loaded && !controller.deleteComplete ? (
            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.deleteAccountHelp')}</Text>}
              title={t('cloudAccount.deleteAccountTitle')}
            >
              <Label title={t('cloudAccount.deleteAccountWarningTitle')} systemImage="exclamationmark.triangle.fill" modifiers={[foregroundStyle(colors.error)]}/>
              <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.deleteAccountDescription')}</Text>
              <SecureField
                onTextChange={(value) => {
                  lastDeletePassword.current = value;
                  controller.setDeletePassword(value);
                }}
                placeholder={t('cloudAccount.deleteAccountPasswordPlaceholder')}
                ref={deletePasswordInput}
                modifiers={[disabledModifier(busy)]}
              />
              {enabled ? <TextField
                onTextChange={(value) => {
                  const normalized = normalizeSecondFactorCode(value);
                  lastDeleteCode.current = normalized;
                  controller.setDeleteCode(value);
                  if (normalized !== value) void deleteCodeInput.current?.setText(normalized);
                }}
                placeholder={t('cloudAccount.deleteAccountSecondFactorPlaceholder')}
                ref={deleteCodeInput}
                modifiers={[disabledModifier(busy), textInputAutocapitalization('characters')]}
              /> : null}
              <Button
                label={busy ? t('cloudAccount.deleteAccountDeleting') : t('cloudAccount.deleteAccountAction')}
                role="destructive"
                systemImage="trash"
                onPress={controller.confirmDeleteAccount}
                modifiers={[disabledModifier(!canDelete)]}
              />
            </Section>
          ) : null}

          {section === 'two-step' && controller.loaded && controller.enrollment ? (
            <Section title={t('cloudAccount.totpEnrollTitle')}>
              <RNHostView matchContents={{ vertical: true }}>
                <TotpEnrollmentPanel controller={controller} enrollment={controller.enrollment}/>
              </RNHostView>
            </Section>
          ) : null}

          {section === 'two-step' && controller.loaded && !controller.enrollment && controller.recoveryCodes.length ? (
            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.recoveryCodesHelp')}</Text>}
              title={t('cloudAccount.recoveryCodesTitle')}
            >
              <Text modifiers={[font({ design: 'monospaced', size: 13 }), textSelection(true)]}>{controller.recoveryCodes.join('\n')}</Text>
              <Button label={t('common.confirm')} systemImage="checkmark.circle" onPress={controller.dismissRecoveryCodes}/>
            </Section>
          ) : null}

          {section === 'two-step' && controller.loaded && !controller.enrollment && !controller.recoveryCodes.length ? (
            <Section
              footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.twoStepHelp')}</Text>}
              title={t('cloudAccount.twoStepStatus')}
            >
              <Label
                title={t(enabled ? 'cloudAccount.twoStepEnabled' : 'cloudAccount.twoStepDisabled')}
                systemImage={enabled ? 'checkmark.shield.fill' : 'shield'}
                modifiers={[foregroundStyle(enabled ? colors.sessionActive : 'secondary')]}
              />
              <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>
                {t(enabled ? 'cloudAccount.twoStepEnabledDescription' : 'cloudAccount.twoStepDisabledDescription')}
              </Text>
              {enabled ? <>
                <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('cloudAccount.stepUpDescription')}</Text>
                <SecureField
                  onTextChange={(value) => {
                    lastStepUp.current = value;
                    controller.setStepUp(value);
                  }}
                  placeholder={t('cloudAccount.stepUpPasswordPlaceholder')}
                  ref={stepUpInput}
                  modifiers={[disabledModifier(busy)]}
                />
                <TextField
                  onTextChange={(value) => {
                    const normalized = normalizeSecondFactorCode(value);
                    lastStepCode.current = normalized;
                    controller.setStepCode(value);
                    if (normalized !== value) void stepCodeInput.current?.setText(normalized);
                  }}
                  placeholder={t('cloudAccount.stepUpCodePlaceholder')}
                  ref={stepCodeInput}
                  modifiers={[disabledModifier(busy), textInputAutocapitalization('characters')]}
                />
              </> : null}
              <Button
                label={t(enabled ? 'cloudAccount.replaceAuthenticator' : 'cloudAccount.enableAuthenticator')}
                systemImage="lock.shield"
                onPress={controller.beginTotp}
                modifiers={[disabledModifier(busy || Boolean(enabled && !controller.stepUp))]}
              />
              {enabled ? <Button
                label={t('cloudAccount.disableAuthenticator')}
                role="destructive"
                systemImage="lock.open"
                onPress={controller.disableTotp}
                modifiers={[disabledModifier(busy || !controller.stepUp)]}
              /> : null}
            </Section>
          ) : null}
        </List>
      </Host>
    </View>
  );
}
