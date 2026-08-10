import { useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, Stack } from 'expo-router';

import { NativeActionButton } from '../src/components/NativeActionButton';
import { CloudAuthHint, CloudAuthLabel, CloudAuthScaffold } from '../src/components/CloudAuthScaffold';
import { OneTimeCodeInput } from '../src/components/OneTimeCodeInput';
import { useMobileTheme } from '../src/components/theme';
import { cloudMobileErrorMessage } from '../src/control-plane/cloud-error';
import { mobileCloudAccountSession as account, saveActiveCloudAccountReference } from '../src/control-plane/runtime';
import { useI18n } from '../src/i18n';

const REDIRECT_URI = 'taskhandoff://cloud-auth/callback';

export default function CloudAccountTotpScreen() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [challengeAvailable] = useState(() => account.hasPendingEmailSecondFactor());
  const [error, setError] = useState<string | undefined>(() => challengeAvailable ? undefined : t('cloudAccount.challengeExpired'));

  async function submit() {
    Keyboard.dismiss(); setBusy(true); setError(undefined);
    try {
      const result = await account.continueEmailLogin(mode === 'totp' ? { totpCode: code } : { recoveryCode: recoveryCode.trim() });
      if (!result.code || !result.state) throw Object.assign(new Error('Authorization code missing.'), { code: 'CLOUD_TOKEN_RESPONSE_INVALID' });
      await account.completeLogin({ code: result.code, state: result.state, redirectUri: REDIRECT_URI });
      await saveActiveCloudAccountReference();
      router.dismissAll();
      router.replace('/cloud-control-planes' as never);
    } catch (cause) {
      const errorCode = cloudErrorCode(cause);
      if (errorCode === 'TOTP_INVALID') { setCode(''); setError(t('cloudAccount.totpInvalid')); }
      else if (errorCode === 'RECOVERY_CODE_INVALID_OR_CONSUMED') { setRecoveryCode(''); setError(t('cloudAccount.recoveryInvalid')); }
      else if (errorCode === 'CLOUD_LOGIN_CHALLENGE_EXPIRED') setError(t('cloudAccount.challengeExpired'));
      else setError(cloudMobileErrorMessage(cause, locale === 'zh-CN'));
    } finally { setBusy(false); }
  }

  const valid = mode === 'totp' ? code.length === 6 : Boolean(recoveryCode.trim());
  return <>
    <Stack.Screen options={{ headerStyle: { backgroundColor: colors.background }, title: '' }}/>
    <CloudAuthScaffold
      description={t(mode === 'totp' ? 'cloudAccount.totpDescription' : 'cloudAccount.recoveryDescription')}
      error={error}
      title={t(mode === 'totp' ? 'cloudAccount.totpTitle' : 'cloudAccount.recoveryTitle')}
    >
      <View style={styles.form}>
        <CloudAuthLabel>{t(mode === 'totp' ? 'cloudAccount.totpCode' : 'cloudAccount.recoveryCode')}</CloudAuthLabel>
        {mode === 'totp' ? (
          <OneTimeCodeInput accessibilityLabel={t('cloudAccount.totpCode')} autoFocus disabled={busy} onChangeText={(value) => { setCode(value); setError(undefined); }} value={code}/>
        ) : (
          <TextInput
            accessibilityLabel={t('cloudAccount.recoveryCode')}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            editable={!busy}
            onChangeText={(value) => { setRecoveryCode(value.toUpperCase()); setError(undefined); }}
            onSubmitEditing={() => { if (valid && !busy) void submit(); }}
            placeholder={t('cloudAccount.recoveryPlaceholder')}
            placeholderTextColor={colors.textMuted}
            returnKeyType="go"
            style={[styles.recoveryInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            value={recoveryCode}
          />
        )}
        <NativeActionButton disabled={busy || !valid || !challengeAvailable} label={busy ? t('cloudAccount.totpChecking') : t('cloudAccount.totpContinue')} onPress={() => void submit()}/>
      </View>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setMode((value) => value === 'totp' ? 'recovery' : 'totp'); setCode(''); setRecoveryCode(''); setError(undefined); }}><Text style={[styles.modeSwitch, { color: colors.primary }]}>{t(mode === 'totp' ? 'cloudAccount.useRecovery' : 'cloudAccount.useAuthenticator')}</Text></Pressable>
      <CloudAuthHint>{t('cloudAccount.securityNote')}</CloudAuthHint>
    </CloudAuthScaffold>
  </>;
}

function cloudErrorCode(error: unknown) { return typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''; }

const styles = StyleSheet.create({
  form: { gap: 18 },
  recoveryInput: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, fontFamily: 'monospace', fontSize: 16, letterSpacing: 0.8, minHeight: 54, paddingHorizontal: 13, textAlign: 'center' },
  modeSwitch: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
});
