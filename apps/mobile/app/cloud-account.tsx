import { useCallback, useEffect, useState } from 'react';
import { Keyboard, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, Stack } from 'expo-router';

import { NativeActionButton } from '../src/components/NativeActionButton';
import { CloudAuthHint, CloudAuthLabel, CloudAuthScaffold } from '../src/components/CloudAuthScaffold';
import { SystemIcon } from '../src/components/SystemIcon';
import { useMobileTheme } from '../src/components/theme';
import { cloudMobileErrorMessage } from '../src/control-plane/cloud-error';
import { hasActiveCloudAccount, mobileCloudAccountSession as account, saveActiveCloudAccountReference } from '../src/control-plane/runtime';
import { useI18n } from '../src/i18n';

type Mode = 'login' | 'register' | 'verify';
const REDIRECT_URI = 'taskhandoff://cloud-auth/callback';

export default function CloudAccountScreen() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verification, setVerification] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const complete = useCallback(async (url: string) => {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    if (!code || !state) return;
    setBusy(true); setError(undefined);
    try {
      await account.completeLogin({ code, state, redirectUri: REDIRECT_URI });
      await saveActiveCloudAccountReference();
      router.replace('/cloud-control-planes' as never);
    } catch (cause) {
      setError(cloudMobileErrorMessage(cause, locale === 'zh-CN'));
    } finally { setBusy(false); }
  }, [locale]);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => { void complete(url); });
    return () => subscription.remove();
  }, [complete]);
  useEffect(() => { void hasActiveCloudAccount().then((active) => { if (active) router.replace('/cloud-control-planes' as never); }); }, []);

  async function authenticate(providerId: 'email' | 'google' | 'github') {
    Keyboard.dismiss(); setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await account.beginLogin({
        providerId,
        redirectUri: REDIRECT_URI,
        email: providerId === 'email' ? email.trim() : undefined,
        password: providerId === 'email' ? password : undefined,
      }) as { authorizationUrl?: string; code?: string; state?: string };
      if (result.authorizationUrl) await Linking.openURL(result.authorizationUrl);
      else if (result.code && result.state) await complete(`${REDIRECT_URI}?code=${encodeURIComponent(result.code)}&state=${encodeURIComponent(result.state)}`);
    } catch (cause) {
      if (cloudErrorCode(cause) === 'TOTP_REQUIRED') {
        router.push('/cloud-account-totp' as never);
      } else setError(cloudMobileErrorMessage(cause, locale === 'zh-CN'));
    } finally { setBusy(false); }
  }

  async function register() {
    Keyboard.dismiss(); setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await account.register({ email: email.trim(), password, termsVersion: '2026-08', acceptTerms: true });
      setPassword(''); setMode('verify');
    } catch (cause) { setError(cloudMobileErrorMessage(cause, locale === 'zh-CN')); }
    finally { setBusy(false); }
  }

  async function verify() {
    Keyboard.dismiss(); setBusy(true); setError(undefined);
    try {
      await account.verifyEmail({ capability: verification.trim() });
      setVerification(''); setMode('login'); setNotice(t('cloudAccount.verified'));
    } catch (cause) { setError(cloudMobileErrorMessage(cause, locale === 'zh-CN')); }
    finally { setBusy(false); }
  }

  const title = mode === 'login' ? t('cloudAccount.loginTitle') : mode === 'register' ? t('cloudAccount.registerTitle') : t('cloudAccount.verifyTitle');
  const description = mode === 'login' ? t('cloudAccount.loginDescription') : mode === 'register' ? t('cloudAccount.registerDescription') : t('cloudAccount.verifyDescription');

  return <>
    <Stack.Screen options={{ headerStyle: { backgroundColor: colors.background }, title: '' }} />
    <CloudAuthScaffold description={description} error={error} title={title}>
      {notice ? <View style={[styles.notice, { backgroundColor: colors.primarySoft }]}><SystemIcon android="check_circle" color={colors.primary} ios="checkmark.circle.fill" size={18}/><Text style={[styles.noticeText, { color: colors.text }]}>{notice}</Text></View> : null}
      <View style={styles.form}>
        {mode === 'verify' ? <>
          <CloudAuthLabel>{t('cloudAccount.verificationToken')}</CloudAuthLabel>
          <TextInput
            accessibilityLabel={t('cloudAccount.verificationToken')}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            onChangeText={(value) => { setVerification(value); setError(undefined); }}
            onSubmitEditing={() => { if (verification.trim() && !busy) void verify(); }}
            placeholder={t('cloudAccount.verificationToken')}
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
            style={[styles.standaloneInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            value={verification}
          />
        </> : <>
          <View style={styles.field}>
            <CloudAuthLabel>{t('cloudAccount.email')}</CloudAuthLabel>
            <View
              style={[styles.inputRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <SystemIcon android="mail" color={colors.textMuted} ios="envelope" size={18}/>
              <TextInput accessibilityLabel={t('cloudAccount.email')} autoCapitalize="none" autoCorrect={false} editable={!busy} inputMode="email" keyboardType="email-address" onChangeText={(value) => { setEmail(value); setError(undefined); }} placeholder={t('cloudAccount.emailPlaceholder')} placeholderTextColor={colors.textMuted} returnKeyType="next" style={[styles.input, { color: colors.text }]} textContentType="emailAddress" value={email}/>
            </View>
          </View>
          <View style={styles.field}>
            <CloudAuthLabel>{t('cloudAccount.password')}</CloudAuthLabel>
            <View
              style={[styles.inputRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <SystemIcon android="lock" color={colors.textMuted} ios="lock" size={18}/>
              <TextInput accessibilityLabel={t('cloudAccount.password')} editable={!busy} onChangeText={(value) => { setPassword(value); setError(undefined); }} onSubmitEditing={() => { if (mode === 'login' && email.trim() && password && !busy) void authenticate('email'); }} placeholder={t('cloudAccount.passwordPlaceholder')} placeholderTextColor={colors.textMuted} returnKeyType={mode === 'login' ? 'go' : 'done'} secureTextEntry={!passwordVisible} style={[styles.input, { color: colors.text }]} textContentType={mode === 'login' ? 'password' : 'newPassword'} value={password}/>
              <Pressable accessibilityLabel={t(passwordVisible ? 'cloudAccount.hidePassword' : 'cloudAccount.showPassword')} accessibilityRole="button" hitSlop={10} onPress={() => setPasswordVisible((value) => !value)}><SystemIcon android={passwordVisible ? 'visibility_off' : 'visibility'} color={colors.textMuted} ios={passwordVisible ? 'eye.slash' : 'eye'} size={18}/></Pressable>
            </View>
            {mode === 'register' ? <Text style={[styles.passwordHint, { color: password.length >= 12 ? colors.sessionActive : colors.textMuted }]}>{t('cloudAccount.passwordHint')}</Text> : null}
          </View>
        </>}
        {mode === 'login' ? <NativeActionButton disabled={busy || !email.trim() || !password} label={busy ? t('cloudAccount.signingIn') : t('cloudAccount.signInEmail')} onPress={() => void authenticate('email')}/>
          : mode === 'register' ? <NativeActionButton disabled={busy || !email.trim() || password.length < 12} label={busy ? t('cloudAccount.creating') : t('cloudAccount.createAccount')} onPress={() => void register()}/>
          : <NativeActionButton disabled={busy || !verification.trim()} label={busy ? t('cloudAccount.verifying') : t('cloudAccount.verify')} onPress={() => void verify()}/>}
      </View>

      {mode === 'login' ? <>
        <AuthDivider label={t('cloudAccount.orContinue')}/>
        <View style={styles.providers}>
          <ProviderButton disabled={busy} label="Google" mark="G" onPress={() => void authenticate('google')}/>
          <ProviderButton disabled={busy} label="GitHub" mark="⌘" onPress={() => void authenticate('github')}/>
        </View>
      </> : null}

      <View style={styles.switchRow}>
        <Text style={[styles.switchPrompt, { color: colors.textMuted }]}>{t(mode === 'login' ? 'cloudAccount.noAccount' : 'cloudAccount.haveAccount')}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(undefined); setNotice(undefined); }}><Text style={[styles.switchAction, { color: colors.primary }]}>{t(mode === 'login' ? 'cloudAccount.createAccount' : 'cloudAccount.signInEmail')}</Text></Pressable>
      </View>
      <CloudAuthHint>{t('cloudAccount.securityNote')}</CloudAuthHint>
    </CloudAuthScaffold>
  </>;
}

function AuthDivider({ label }: { label: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.dividerRow}><View style={[styles.divider, { backgroundColor: colors.border }]}/><Text style={[styles.dividerLabel, { color: colors.textMuted }]}>{label}</Text><View style={[styles.divider, { backgroundColor: colors.border }]}/></View>;
}

function ProviderButton({ disabled, label, mark, onPress }: { disabled: boolean; label: string; mark: string; onPress: () => void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.providerButton, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled, pressed && { backgroundColor: colors.surfaceMuted }]}><Text style={[styles.providerMark, { color: colors.text }]}>{mark}</Text><Text style={[styles.providerLabel, { color: colors.text }]}>{label}</Text></Pressable>;
}

function cloudErrorCode(error: unknown) { return typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''; }

const styles = StyleSheet.create({
  form: { gap: 16 },
  field: { gap: 7 },
  inputRow: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 52, paddingHorizontal: 13 },
  input: { flex: 1, fontSize: 16, minHeight: 50, paddingVertical: 0 },
  standaloneInput: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, fontSize: 16, minHeight: 52, paddingHorizontal: 13 },
  passwordHint: { fontSize: 12, lineHeight: 17 },
  providers: { flexDirection: 'row', gap: 10 },
  providerButton: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flex: 1, flexDirection: 'row', gap: 9, justifyContent: 'center', minHeight: 48, paddingHorizontal: 12 },
  providerMark: { fontSize: 17, fontWeight: '800' },
  providerLabel: { fontSize: 15, fontWeight: '600' },
  dividerRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  divider: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  switchRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 5, justifyContent: 'center' },
  switchPrompt: { fontSize: 14 },
  switchAction: { fontSize: 14, fontWeight: '700' },
  notice: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 9, padding: 12 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 19 },
  disabled: { opacity: 0.45 },
});
