import { useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';

import { NativeActionButton } from '../src/components/NativeActionButton';
import { CloudAuthLabel, CloudAuthScaffold } from '../src/components/CloudAuthScaffold';
import { OneTimeCodeInput } from '../src/components/OneTimeCodeInput';
import { normalizeOneTimeCode } from '../src/components/one-time-code';
import { formatRecoveryCode, normalizeRecoveryCode } from '../src/components/recovery-code';
import { useMobileTheme } from '../src/components/theme';
import { cloudMobileErrorMessage } from '../src/control-plane/cloud-error';
import { mobileCloudAccountSession as account, saveActiveCloudAccountReference } from '../src/control-plane/runtime';
import { useI18n } from '../src/i18n';
import { errorHaptic, successHaptic } from '../src/platform/haptics';
import { isMobileFeatureEnabled, mobileAppScheme } from '../src/platform/build-variant';

const REDIRECT_URI = `${mobileAppScheme}://official-auth/callback`;

export default function CloudAccountTotpScreen() {
  if (!isMobileFeatureEnabled('officialAccount')) return <Redirect href="/profiles" />;
  return <CloudAccountTotpContent />;
}

function CloudAccountTotpContent() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const [challengeAvailable] = useState(() => account.hasPendingEmailSecondFactor());
  const [error, setError] = useState<string | undefined>(() => challengeAvailable ? undefined : t('cloudAccount.challengeExpired'));
  const recoveryInput = useRef<TextInput>(null);

  async function submit(input?: { totpCode?: string; recoveryCode?: string }) {
    const totpCode = normalizeOneTimeCode(input?.totpCode ?? code);
    const recovery = formatRecoveryCode(input?.recoveryCode ?? recoveryCode);
    const candidateValid = mode === 'totp' ? totpCode.length === 6 : normalizeRecoveryCode(recovery).length > 0;
    if (busy || !challengeAvailable || !candidateValid) return;
    Keyboard.dismiss(); setBusy(true); setError(undefined);
    try {
      const result = await account.continueEmailLogin(mode === 'totp' ? { totpCode } : { recoveryCode: recovery });
      if (!result.code || !result.state) throw Object.assign(new Error('Authorization code missing.'), { code: 'CLOUD_TOKEN_RESPONSE_INVALID' });
      await account.completeLogin({ code: result.code, state: result.state, redirectUri: REDIRECT_URI });
      await saveActiveCloudAccountReference();
      successHaptic();
      router.dismissAll();
      router.replace('/cloud-control-planes' as never);
    } catch (cause) {
      errorHaptic();
      const errorCode = cloudErrorCode(cause);
      if (errorCode === 'TOTP_INVALID') { setCode(''); setFocusKey((value) => value + 1); setError(t('cloudAccount.totpInvalid')); }
      else if (errorCode === 'RECOVERY_CODE_INVALID_OR_CONSUMED') { setRecoveryCode(''); setTimeout(() => recoveryInput.current?.focus(), 0); setError(t('cloudAccount.recoveryInvalid')); }
      else if (errorCode === 'CLOUD_LOGIN_CHALLENGE_EXPIRED') setError(t('cloudAccount.challengeExpired'));
      else setError(cloudMobileErrorMessage(cause, locale === 'zh-CN'));
    } finally { setBusy(false); }
  }

  const valid = mode === 'totp' ? normalizeOneTimeCode(code).length === 6 : normalizeRecoveryCode(recoveryCode).length > 0;
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
          <OneTimeCodeInput
            accessibilityLabel={t('cloudAccount.totpCode')}
            autoFocus
            disabled={busy}
            focusKey={focusKey}
            onChangeText={(value) => { setCode(value); setError(undefined); }}
            onComplete={(value) => void submit({ totpCode: value })}
            value={code}
          />
        ) : (
          <TextInput
            accessibilityLabel={t('cloudAccount.recoveryCode')}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            editable={!busy}
            onChangeText={(value) => {
              const formatted = formatRecoveryCode(value);
              setRecoveryCode(formatted);
              setError(undefined);
            }}
            onSubmitEditing={() => { if (valid && !busy) void submit(); }}
            placeholder={t('cloudAccount.recoveryPlaceholder')}
            placeholderTextColor={colors.textMuted}
            ref={recoveryInput}
            returnKeyType="go"
            style={[styles.recoveryInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            value={recoveryCode}
          />
        )}
        <NativeActionButton disabled={busy || !valid || !challengeAvailable} label={busy ? t('cloudAccount.totpChecking') : t('cloudAccount.totpContinue')} onPress={() => void submit()}/>
      </View>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setMode((value) => value === 'totp' ? 'recovery' : 'totp'); setCode(''); setRecoveryCode(''); setError(undefined); }}><Text style={[styles.modeSwitch, { color: colors.primary }]}>{t(mode === 'totp' ? 'cloudAccount.useRecovery' : 'cloudAccount.useAuthenticator')}</Text></Pressable>
    </CloudAuthScaffold>
  </>;
}

function cloudErrorCode(error: unknown) { return typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''; }

const styles = StyleSheet.create({
  form: { gap: 18 },
  recoveryInput: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, fontFamily: 'monospace', fontSize: 16, letterSpacing: 0.8, minHeight: 54, paddingHorizontal: 13, textAlign: 'center' },
  modeSwitch: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
});
