import { useCallback, useEffect, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import type { OfficialProviderSummary } from '@task-handoff/cloud-contracts/mobile';

import { NativeActionButton } from '../src/components/NativeActionButton';
import { CloudAuthLabel, CloudAuthScaffold } from '../src/components/CloudAuthScaffold';
import { Icon } from '../src/components/Icon';
import { OneTimeCodeInput } from '../src/components/OneTimeCodeInput';
import { ProviderIcon } from '../src/components/ProviderIcon';
import { useMobileTheme } from '../src/components/theme';
import { cloudMobileErrorMessage } from '../src/control-plane/cloud-error';
import { hasActiveCloudAccount, mobileCloudAccountSession as account, saveActiveCloudAccountReference } from '../src/control-plane/runtime';
import { useI18n } from '../src/i18n';
import { isMobileFeatureEnabled, mobileAppScheme } from '../src/platform/build-variant';
import { nativeAppleAuthentication } from '../src/platform/apple-authentication';

type Mode = 'login' | 'register' | 'verify' | 'provider-confirm';
const REDIRECT_URI = `${mobileAppScheme}://official-auth/callback`;

export default function CloudAccountScreen() {
  if (!isMobileFeatureEnabled('officialAccount')) return <Redirect href="/profiles" />;
  return <CloudAccountContent />;
}

function CloudAccountContent() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verification, setVerification] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [availableProviders, setAvailableProviders] = useState<OfficialProviderSummary[]>([]);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const thirdPartyProviders = availableProviders;

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

  useEffect(() => { void hasActiveCloudAccount().then((active) => { if (active) router.replace('/cloud-control-planes' as never); }); }, []);
  useEffect(() => () => account.cancelProviderConfirmation(), []);

  useEffect(() => {
    let cancelled = false;
    void account.client.publicProviders()
      .then((providers) => { if (!cancelled) setAvailableProviders(providers); })
      .catch(() => { if (!cancelled) setAvailableProviders([]); });
    return () => { cancelled = true; };
  }, []);

  async function authenticate(providerId: string) {
    Keyboard.dismiss(); setBusy(true); setError(undefined); setNotice(undefined);
    try {
      if (providerId === 'apple') {
        const native = await nativeAppleAuthentication();
        if (native) {
          const result = await account.loginWithApple(native, REDIRECT_URI);
          if (result === 'confirmation-required') {
            setTermsAccepted(false); setMode('provider-confirm');
            return;
          }
          if (result === 'completed') {
            await saveActiveCloudAccountReference();
            router.replace('/cloud-control-planes' as never);
          }
          if (result !== 'unavailable') return;
        }
      }
      const result = await account.beginLogin({
        providerId,
        redirectUri: REDIRECT_URI,
        email: providerId === 'email' ? email.trim() : undefined,
        password: providerId === 'email' ? password : undefined,
      }) as { authorizationUrl?: string; code?: string; state?: string };
      if (result.authorizationUrl) {
        const session = await WebBrowser.openAuthSessionAsync(result.authorizationUrl, REDIRECT_URI);
        if (session.type === 'success') await complete(session.url);
      } else if (result.code && result.state) await complete(`${REDIRECT_URI}?code=${encodeURIComponent(result.code)}&state=${encodeURIComponent(result.state)}`);
    } catch (cause) {
      if (cloudErrorCode(cause) === 'TOTP_REQUIRED') {
        router.push('/cloud-account-totp' as never);
      } else setError(cloudMobileErrorMessage(cause, locale === 'zh-CN'));
    } finally { setBusy(false); }
  }

  async function confirmProviderAccount() {
    if (!termsAccepted) return;
    setBusy(true); setError(undefined);
    try {
      await account.confirmProviderAccount();
      await saveActiveCloudAccountReference();
      router.replace('/cloud-control-planes' as never);
    } catch (cause) { setError(cloudMobileErrorMessage(cause, locale === 'zh-CN')); }
    finally { setBusy(false); }
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
      await account.verifyEmail({ email: email.trim(), code: verification });
      setVerification(''); setMode('login'); setNotice(t('cloudAccount.verified'));
    } catch (cause) {
      setVerification('');
      const code = cloudErrorCode(cause);
      setError(code === 'EMAIL_VERIFICATION_CODE_INVALID' ? t('cloudAccount.verificationCodeInvalid') : code === 'RATE_LIMITED' ? t('cloudAccount.verificationRateLimited') : cloudMobileErrorMessage(cause, locale === 'zh-CN'));
    }
    finally { setBusy(false); }
  }

  const title = mode === 'provider-confirm' ? t('cloudAccount.providerConfirmTitle') : mode === 'login' ? t('cloudAccount.loginTitle') : mode === 'register' ? t('cloudAccount.registerTitle') : t('cloudAccount.verifyTitle');
  const description = mode === 'provider-confirm' ? t('cloudAccount.providerConfirmDescription') : mode === 'login' ? t('cloudAccount.loginDescription') : mode === 'register' ? t('cloudAccount.registerDescription') : t('cloudAccount.verifyDescription');

  return <>
    <Stack.Screen options={{ headerStyle: { backgroundColor: colors.background }, title: '' }} />
    <CloudAuthScaffold description={description} error={error} title={title}>
      {reason === 'reauthentication' ? <View style={[styles.notice, { backgroundColor: colors.primarySoft }]}><Icon color={colors.primary} name="information-circle" size={18}/><Text style={[styles.noticeText, { color: colors.text }]}>{t('cloudAccount.reauthenticationNotice')}</Text></View> : notice ? <View style={[styles.notice, { backgroundColor: colors.primarySoft }]}><Icon color={colors.primary} name="checkmark-circle" size={18}/><Text style={[styles.noticeText, { color: colors.text }]}>{notice}</Text></View> : null}
      <View style={styles.form}>
        {mode === 'provider-confirm' ? <>
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: termsAccepted, disabled: busy }} disabled={busy} onPress={() => setTermsAccepted((value) => !value)} style={styles.termsRow}>
            <Icon color={termsAccepted ? colors.primary : colors.textMuted} name={termsAccepted ? 'checkbox' : 'square-outline'} size={22}/>
            <Text style={[styles.termsText, { color: colors.text }]}>{t('cloudAccount.acceptTerms')}</Text>
          </Pressable>
          <View style={styles.policyLinks}>
            <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(`${account.origin}/terms`)}><Text style={[styles.termsText, { color: colors.primary }]}>{t('cloudAccount.terms')}</Text></Pressable>
            <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(`${account.origin}/privacy`)}><Text style={[styles.termsText, { color: colors.primary }]}>{t('cloudAccount.privacy')}</Text></Pressable>
          </View>
        </> : mode === 'verify' ? <>
          <CloudAuthLabel>{t('cloudAccount.verificationCode')}</CloudAuthLabel>
          <OneTimeCodeInput accessibilityLabel={t('cloudAccount.verificationCode')} autoFocus disabled={busy} onChangeText={(value) => { setVerification(value); setError(undefined); }} value={verification}/>
        </> : <>
          <View style={styles.field}>
            <CloudAuthLabel>{t('cloudAccount.email')}</CloudAuthLabel>
            <View
              style={[styles.inputRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <Icon color={colors.textMuted} name="mail-outline" size={18}/>
              <TextInput accessibilityLabel={t('cloudAccount.email')} autoCapitalize="none" autoCorrect={false} editable={!busy} inputMode="email" keyboardType="email-address" onChangeText={(value) => { setEmail(value); setError(undefined); }} placeholder={t('cloudAccount.emailPlaceholder')} placeholderTextColor={colors.textMuted} returnKeyType="next" style={[styles.input, { color: colors.text }]} testID="cloud-account-email" textContentType="emailAddress" value={email}/>
            </View>
          </View>
          <View style={styles.field}>
            <CloudAuthLabel>{t('cloudAccount.password')}</CloudAuthLabel>
            <View
              style={[styles.inputRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <Icon color={colors.textMuted} name="lock-closed" size={18}/>
              <TextInput accessibilityLabel={t('cloudAccount.password')} editable={!busy} onChangeText={(value) => { setPassword(value); setError(undefined); }} onSubmitEditing={() => { if (mode === 'login' && email.trim() && password && !busy) void authenticate('email'); }} placeholder={t('cloudAccount.passwordPlaceholder')} placeholderTextColor={colors.textMuted} returnKeyType={mode === 'login' ? 'go' : 'done'} secureTextEntry={!passwordVisible} style={[styles.input, { color: colors.text }]} testID="cloud-account-password" textContentType={mode === 'login' ? 'password' : 'newPassword'} value={password}/>
              <Pressable accessibilityLabel={t(passwordVisible ? 'cloudAccount.hidePassword' : 'cloudAccount.showPassword')} accessibilityRole="button" hitSlop={10} onPress={() => setPasswordVisible((value) => !value)}><Icon color={colors.textMuted} name={passwordVisible ? 'eye-off-outline' : 'eye-outline'} size={18}/></Pressable>
            </View>
            {mode === 'register' ? <Text style={[styles.passwordHint, { color: password.length >= 12 ? colors.sessionActive : colors.textMuted }]}>{t('cloudAccount.passwordHint')}</Text> : null}
          </View>
        </>}
        {mode === 'provider-confirm' ? <NativeActionButton disabled={busy || !termsAccepted} label={busy ? t('cloudAccount.creating') : t('cloudAccount.createAccount')} onPress={() => void confirmProviderAccount()}/>
          : mode === 'login' ? <NativeActionButton disabled={busy || !email.trim() || !password} label={busy ? t('cloudAccount.signingIn') : t('cloudAccount.signInEmail')} onPress={() => void authenticate('email')}/>
          : mode === 'register' ? <NativeActionButton disabled={busy || !email.trim() || password.length < 12} label={busy ? t('cloudAccount.creating') : t('cloudAccount.createAccount')} onPress={() => void register()}/>
          : <NativeActionButton disabled={busy || verification.length !== 6} label={busy ? t('cloudAccount.verifying') : t('cloudAccount.verify')} onPress={() => void verify()}/>}
      </View>

      {mode === 'login' && thirdPartyProviders.length ? <>
        <AuthDivider label={t('cloudAccount.orContinue')}/>
        <View style={styles.providers}>
          {thirdPartyProviders.map((provider) => <ProviderButton key={provider.id} disabled={busy} label={provider.displayName} providerId={provider.id} onPress={() => void authenticate(provider.id)}/>)}
        </View>
      </> : null}

      {mode === 'provider-confirm' ? <NativeActionButton disabled={busy} label={t('common.cancel')} onPress={() => { account.cancelProviderConfirmation(); setMode('login'); setError(undefined); }}/>
        : <View style={styles.switchRow}>
        <Text style={[styles.switchPrompt, { color: colors.textMuted }]}>{t(mode === 'login' ? 'cloudAccount.noAccount' : 'cloudAccount.haveAccount')}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(undefined); setNotice(undefined); }}><Text style={[styles.switchAction, { color: colors.primary }]}>{t(mode === 'login' ? 'cloudAccount.createAccount' : 'cloudAccount.signInEmail')}</Text></Pressable>
      </View>}
    </CloudAuthScaffold>
  </>;
}

function AuthDivider({ label }: { label: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.dividerRow}><View style={[styles.divider, { backgroundColor: colors.border }]}/><Text style={[styles.dividerLabel, { color: colors.textMuted }]}>{label}</Text><View style={[styles.divider, { backgroundColor: colors.border }]}/></View>;
}

function ProviderButton({ disabled, label, providerId, onPress }: { disabled: boolean; label: string; providerId: string; onPress: () => void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.providerButton, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled, pressed && { backgroundColor: colors.surface }]}><ProviderIcon color={colors.text} id={providerId}/><Text style={[styles.providerLabel, { color: colors.text }]}>{label}</Text></Pressable>;
}

function cloudErrorCode(error: unknown) { return typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''; }

const styles = StyleSheet.create({
  termsRow: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 48 },
  termsText: { fontSize: 14, lineHeight: 20, flexShrink: 1 },
  policyLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  form: { gap: 16 },
  field: { gap: 7 },
  inputRow: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 52, paddingHorizontal: 13 },
  input: { flex: 1, fontSize: 16, minHeight: 50, paddingVertical: 0 },
  standaloneInput: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, fontSize: 16, minHeight: 52, paddingHorizontal: 13 },
  passwordHint: { fontSize: 12, lineHeight: 17 },
  providers: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  providerButton: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexBasis: 96, flexGrow: 1, flexDirection: 'row', gap: 9, justifyContent: 'center', minHeight: 48, paddingHorizontal: 12 },
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
