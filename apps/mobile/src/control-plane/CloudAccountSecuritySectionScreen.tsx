import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { CommandRow, FieldRow, SettingsDivider, SettingsSection, ValueRow } from './CloudAccountSettingsUI';
import { TotpEnrollmentPanel } from './TotpEnrollmentPanel';
import type { CloudAccountSecurityController } from './use-cloud-account-security';

export type CloudAccountSecuritySection = 'two-step' | 'delete';

type Props = {
  controller: CloudAccountSecurityController;
  onDeleted?(): void;
  section: CloudAccountSecuritySection;
};

export function CloudAccountSecuritySectionScreen({ controller, onDeleted, section }: Props) {
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

  if (section === 'delete') {
    if (controller.deleteComplete) {
      return <Screen testID="delete-account-complete-screen">
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('cloudAccount.deleteAccountScheduledTitle')}</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>{t('cloudAccount.deleteAccountScheduledDescription')}</Text>
        </View>
        <SettingsSection>
          <CommandRow icon="checkmark-outline" label={t('common.confirm')} onPress={onDeleted ?? (() => undefined)}/>
        </SettingsSection>
      </Screen>;
    }

    return <Screen testID="delete-account-screen">
      {controller.message ? <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.error }]}>{controller.message}</Text> : null}
      <DeleteAccountSection controller={controller} enabled={Boolean(controller.profile?.totpEnabled)}/>
    </Screen>;
  }

  if (controller.enrollment) {
    return <Screen testID="two-step-verification-screen">
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('cloudAccount.totpEnrollTitle')}</Text>
      </View>
      <TotpEnrollmentPanel controller={controller} enrollment={controller.enrollment}/>
    </Screen>;
  }

  if (controller.recoveryCodes.length) {
    return <Screen testID="two-step-verification-screen">
      <SettingsSection footer={t('cloudAccount.recoveryCodesHelp')} title={t('cloudAccount.recoveryCodesTitle')}>
        <View style={styles.codeRow}>
          <Text selectable style={[styles.codes, { color: colors.text }]}>{controller.recoveryCodes.join('\n')}</Text>
        </View>
        <SettingsDivider/>
        <CommandRow icon="checkmark-outline" label={t('common.confirm')} onPress={controller.dismissRecoveryCodes}/>
      </SettingsSection>
    </Screen>;
  }

  return <Screen testID="two-step-verification-screen">
    {controller.message ? <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.error }]}>{controller.message}</Text> : null}
    <TwoStepSection controller={controller} enabled={Boolean(controller.profile?.totpEnabled)}/>
  </Screen>;
}

function TwoStepSection({ controller, enabled }: { controller: CloudAccountSecurityController; enabled: boolean }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();

  return <SettingsSection footer={t('cloudAccount.twoStepHelp')} testID="two-step-verification-section" title={t('cloudAccount.totpTitle')}>
    <ValueRow
      color={enabled ? colors.sessionActive : colors.textMuted}
      icon={enabled ? 'shield-checkmark-outline' : 'shield-outline'}
      label={t('cloudAccount.twoStepStatus')}
      value={t(enabled ? 'cloudAccount.twoStepEnabled' : 'cloudAccount.twoStepDisabled')}
    />
    {enabled ? <>
      <SettingsDivider/>
      <FieldRow icon="lock-closed-outline">
        <TextInput
          accessibilityLabel={t('cloudAccount.stepUpPassword')}
          autoComplete="current-password"
          autoCorrect={false}
          editable={!controller.busy}
          onChangeText={controller.setStepUp}
          placeholder={t('cloudAccount.stepUpPasswordPlaceholder')}
          placeholderTextColor={colors.textPlaceholder}
          secureTextEntry
          style={[styles.input, { color: colors.text }]}
          textContentType="password"
          value={controller.stepUp}
        />
      </FieldRow>
      <SettingsDivider/>
      <FieldRow icon="keypad-outline">
        <TextInput
          accessibilityLabel={t('cloudAccount.stepUpCode')}
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect={false}
          editable={!controller.busy}
          onChangeText={controller.setStepCode}
          placeholder={t('cloudAccount.stepUpCodePlaceholder')}
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.input, styles.codeInput, { color: colors.text }]}
          textContentType="oneTimeCode"
          value={controller.stepCode}
        />
      </FieldRow>
    </> : null}
    <SettingsDivider/>
    <CommandRow
      disabled={controller.busy || (enabled && !controller.stepUp)}
      icon="lock-closed-outline"
      label={t(enabled ? 'cloudAccount.replaceAuthenticator' : 'cloudAccount.enableAuthenticator')}
      onPress={controller.beginTotp}
    />
    {enabled ? <>
      <SettingsDivider/>
      <CommandRow
        destructive
        disabled={controller.busy || !controller.stepUp}
        icon="lock-open-outline"
        label={t('cloudAccount.disableAuthenticator')}
        onPress={controller.disableTotp}
      />
    </> : null}
  </SettingsSection>;
}

function DeleteAccountSection({ controller, enabled }: { controller: CloudAccountSecurityController; enabled: boolean }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [passwordRevealed, setPasswordRevealed] = useState(false);
  const canDelete = !controller.busy
    && Boolean(controller.deletePassword)
    && (!enabled || Boolean(controller.deleteCode));

  return <SettingsSection footer={t('cloudAccount.deleteAccountHelp')} testID="account-deletion-section" title={t('cloudAccount.deleteAccountTitle')}>
    <View style={styles.warningRow}>
      <Icon color={colors.error} name="warning-outline" size={21}/>
      <View style={styles.warningCopy}>
        <Text style={[styles.warningTitle, { color: colors.error }]}>{t('cloudAccount.deleteAccountWarningTitle')}</Text>
        <Text style={[styles.warningText, { color: colors.textMuted }]}>{t('cloudAccount.deleteAccountConfirmDescription')}</Text>
      </View>
    </View>
    <SettingsDivider/>
    <FieldRow icon="lock-closed-outline">
      <TextInput
        accessibilityLabel={t('cloudAccount.deleteAccountPassword')}
        autoComplete="current-password"
        autoCorrect={false}
        editable={!controller.busy}
        onChangeText={controller.setDeletePassword}
        placeholder={t('cloudAccount.deleteAccountPasswordPlaceholder')}
        placeholderTextColor={colors.textPlaceholder}
        secureTextEntry={!passwordRevealed}
        style={[styles.input, { color: colors.text }]}
        textContentType="password"
        value={controller.deletePassword}
      />
    </FieldRow>
    <Pressable
      accessibilityLabel={t(passwordRevealed ? 'common.hide' : 'common.show')}
      accessibilityRole="button"
      disabled={controller.busy}
      onPress={() => setPasswordRevealed((revealed) => !revealed)}
      style={({ pressed }) => [styles.textAction, pressed && styles.pressed]}
    >
      <Text style={[styles.textActionLabel, { color: colors.primary }]}>{t(passwordRevealed ? 'common.hide' : 'common.show')}</Text>
    </Pressable>
    {enabled ? <>
      <SettingsDivider/>
      <FieldRow icon="keypad-outline">
        <TextInput
          accessibilityLabel={t('cloudAccount.deleteAccountSecondFactor')}
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect={false}
          editable={!controller.busy}
          onChangeText={controller.setDeleteCode}
          placeholder={t('cloudAccount.deleteAccountSecondFactorPlaceholder')}
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.input, styles.codeInput, { color: colors.text }]}
          textContentType="oneTimeCode"
          value={controller.deleteCode}
        />
      </FieldRow>
    </> : null}
    <SettingsDivider/>
    <CommandRow
      destructive
      disabled={!canDelete}
      icon="trash-outline"
      label={controller.busy ? t('cloudAccount.deleteAccountDeleting') : t('cloudAccount.deleteAccountAction')}
      onPress={controller.confirmDeleteAccount}
      testID="delete-account-submit"
    />
  </SettingsSection>;
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', flexGrow: 1, gap: 10, justifyContent: 'center' },
  loadingText: { fontSize: 13 },
  heading: { gap: 3, paddingTop: 2 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.4 },
  description: { fontSize: 13, lineHeight: 18 },
  message: { fontSize: 13, lineHeight: 19, marginHorizontal: 14 },
  input: { flex: 1, fontSize: 16, minHeight: 48, paddingVertical: 10 },
  codeInput: { letterSpacing: 0.8 },
  warningRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 11, paddingHorizontal: 14, paddingVertical: 12 },
  warningCopy: { flex: 1, gap: 4 },
  warningTitle: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  warningText: { fontSize: 13, lineHeight: 18 },
  textAction: { alignSelf: 'flex-start', justifyContent: 'center', marginLeft: 45, minHeight: 38 },
  textActionLabel: { fontSize: 13, lineHeight: 18 },
  codeRow: { paddingHorizontal: 14, paddingVertical: 12 },
  codes: { fontFamily: 'monospace', fontSize: 15, lineHeight: 24 },
  pressed: { opacity: 0.72 },
});
