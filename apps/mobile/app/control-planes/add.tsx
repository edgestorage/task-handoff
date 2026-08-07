import { useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, Stack } from 'expo-router';

import { Screen } from '../../src/components/Screen';
import { NativeActionButton } from '../../src/components/NativeActionButton';
import { SystemIcon } from '../../src/components/SystemIcon';
import { useMobileTheme } from '../../src/components/theme';
import {
  DirectEnrollmentError,
  assertDirectIdentityCompatible,
  existingDirectControlPlaneProfile,
  loginDirectControlPlane,
  probeDirectControlPlane,
  type VerifiedDirectControlPlane,
} from '../../src/control-plane/direct-enrollment';
import { mobileProfileStore as profiles, mobileSecureStore as secureStore } from '../../src/control-plane/runtime';
import { isMobileTestMode } from '../../src/platform/build-variant';
import { useI18n, type Translate } from '../../src/i18n';

type EnrollmentStep = 'address' | 'identity' | 'credentials';

export default function AddControlPlaneScreen() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [step, setStep] = useState<EnrollmentStep>('address');
  const [address, setAddress] = useState('');
  const [target, setTarget] = useState<VerifiedDirectControlPlane>();
  const [existing, setExisting] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const verifyAddress = async () => {
    Keyboard.dismiss();
    setBusy(true);
    setError(undefined);
    try {
      const verified = await probeDirectControlPlane(address, { allowInsecureHttp: isMobileTestMode });
      const saved = await profiles.list();
      assertDirectIdentityCompatible(verified, saved);
      setTarget(verified);
      setExisting(Boolean(existingDirectControlPlaneProfile(verified, saved)));
      setAddress(verified.origin);
      setStep('identity');
    } catch (cause) {
      setTarget(undefined);
      setExisting(false);
      setError(messageFor(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!target) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(undefined);
    try {
      const profile = await loginDirectControlPlane(target, { username: username.trim(), password }, secureStore);
      await profiles.put(profile);
      setPassword('');
      router.replace('/(tabs)/(main)/inbox');
    } catch (cause) {
      setError(messageFor(cause, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: step === 'address' ? t('nav.addControlPlane') : t('enroll.connect') }} />
      <Screen>
        <View style={styles.progressHeader}>
          <Text style={[styles.stepLabel, { color: colors.primary }]}>{t('enroll.step', { current: stepNumber(step) })}</Text>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{titleFor(step, t)}</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>{descriptionFor(step, t)}</Text>
        </View>

        <View accessibilityRole="progressbar" accessibilityValue={{ min: 1, max: 3, now: stepNumber(step) }} style={[styles.progressTrack, { backgroundColor: colors.border }]}> 
          <View style={[styles.progressValue, { backgroundColor: colors.primary, width: `${stepNumber(step) * 33.333}%` }]} />
        </View>

        {step === 'address' ? (
          <>
            <SectionLabel label={t('enroll.connection')} color={colors.textMuted} />
            <View style={[styles.formGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
              <View style={styles.inputRow}>
                <SystemIcon android="language" color={colors.textMuted} ios="network" size={19} />
                <TextInput
                  accessibilityLabel={t('enroll.address')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  inputMode="url"
                  onChangeText={(value) => { setAddress(value); setTarget(undefined); setError(undefined); }}
                  onSubmitEditing={() => { if (address.trim() && !busy) void verifyAddress(); }}
                  placeholder={isMobileTestMode ? 'http://192.168.1.10:8081' : 'https://control.example.com'}
                  placeholderTextColor={colors.textMuted}
                  returnKeyType="next"
                  style={[styles.input, { color: colors.text }]}
                  value={address}
                />
                {address ? <Pressable accessibilityLabel="Clear address" hitSlop={10} onPress={() => setAddress('')}><SystemIcon android="cancel" color={colors.textMuted} ios="xmark.circle.fill" size={18} /></Pressable> : null}
              </View>
            </View>
            <Text style={[styles.footnote, { color: colors.textMuted }]}>{t('enroll.verifyHelp')}</Text>

            {isMobileTestMode ? (
              <View style={[styles.notice, { backgroundColor: colors.notice }]}> 
                <SystemIcon android="warning" color={colors.noticeText} ios="exclamationmark.triangle.fill" size={17} />
                <Text style={[styles.noticeText, { color: colors.noticeText }]}><Text style={styles.noticeStrong}>{t('enroll.testMode')}</Text>{t('enroll.testModeHelp')}</Text>
              </View>
            ) : null}

            <View style={styles.primaryAction}><NativeActionButton disabled={busy || !address.trim()} icon={{ android: 'verified_user', ios: 'checkmark.shield' }} label={t('enroll.verifyAddress')} onPress={() => { void verifyAddress(); }} /></View>
          </>
        ) : null}

        {step === 'identity' && target ? (
          <>
            <SectionLabel label={t('enroll.verifiedIdentity')} color={colors.textMuted} />
            <View style={[styles.formGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
              <IdentityRow icon="network" label={t('controlPlane.address')} value={target.origin} />
              <Divider color={colors.border} />
              <IdentityRow icon="server.rack" label={t('controlPlane.id')} value={target.identity.controlPlaneId} />
              <Divider color={colors.border} />
              <IdentityRow icon="key.horizontal" label={t('enroll.signingKey')} value={target.identity.publicKey.fingerprint} monospace />
            </View>
            <View style={styles.verifiedNote}>
              <SystemIcon android="verified_user" color="#34c759" ios="checkmark.seal.fill" size={20} />
              <Text style={[styles.verifiedText, { color: colors.textMuted }]}>{t('enroll.verifiedHelp')}</Text>
            </View>
            {existing ? <View style={[styles.notice, { backgroundColor: colors.notice }]}><Text style={[styles.noticeText, { color: colors.noticeText }]}>{t('enroll.existing')}</Text></View> : null}
            <View style={styles.primaryAction}><NativeActionButton icon={{ android: 'arrow_forward', ios: 'arrow.right' }} label={t('enroll.continueSignIn')} onPress={() => { setError(undefined); setStep('credentials'); }} /></View>
            <NativeActionButton compact label={t('enroll.differentAddress')} onPress={() => { setError(undefined); setTarget(undefined); setStep('address'); }} />
          </>
        ) : null}

        {step === 'credentials' && target ? (
          <>
            <SectionLabel label={t('enroll.signIn')} color={colors.textMuted} />
            <View style={[styles.formGroup, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
              <View style={styles.inputRow}>
                <SystemIcon android="person" color={colors.textMuted} ios="person" size={19} />
                <TextInput
                  accessibilityLabel={t('enroll.username')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  onChangeText={(value) => { setUsername(value); setError(undefined); }}
                  placeholder={t('enroll.username')}
                  placeholderTextColor={colors.textMuted}
                  returnKeyType="next"
                  style={[styles.input, { color: colors.text }]}
                  textContentType="username"
                  value={username}
                />
              </View>
              <Divider color={colors.border} inset />
              <View style={styles.inputRow}>
                <SystemIcon android="lock" color={colors.textMuted} ios="lock" size={19} />
                <TextInput
                  accessibilityLabel={t('enroll.password')}
                  editable={!busy}
                  onChangeText={(value) => { setPassword(value); setError(undefined); }}
                  onSubmitEditing={() => { if (username.trim() && password && !busy) void connect(); }}
                  placeholder={t('enroll.password')}
                  placeholderTextColor={colors.textMuted}
                  returnKeyType="go"
                  secureTextEntry
                  style={[styles.input, { color: colors.text }]}
                  textContentType="password"
                  value={password}
                />
              </View>
            </View>
            <Text numberOfLines={1} style={[styles.footnote, { color: colors.textMuted }]}>{t('enroll.signingInto', { address: target.origin })}</Text>
            <View style={styles.primaryAction}><NativeActionButton disabled={busy || !username.trim() || !password} icon={{ android: 'login', ios: 'person.badge.key' }} label={existing ? t('enroll.signInUpdate') : t('enroll.connectControlPlane')} onPress={() => { void connect(); }} /></View>
            <NativeActionButton compact disabled={busy} label={t('enroll.backIdentity')} onPress={() => { setError(undefined); setStep('identity'); }} />
          </>
        ) : null}

        {busy ? <View style={styles.busyRow}><ActivityIndicator accessibilityLabel={step === 'address' ? t('enroll.verifying') : t('enroll.connecting')} /><Text style={[styles.busyText, { color: colors.textMuted }]}>{step === 'address' ? t('enroll.verifyingIdentity') : t('enroll.signingIn')}</Text></View> : null}
        {error ? <View style={[styles.errorGroup, { backgroundColor: colors.errorSoft }]}><SystemIcon android="error" color={colors.error} ios="exclamationmark.circle.fill" size={18} /><Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{error}</Text></View> : null}
      </Screen>
    </>
  );
}

function SectionLabel({ color, label }: { color: string; label: string }) {
  return <Text style={[styles.sectionLabel, { color }]}>{label}</Text>;
}

function Divider({ color, inset = false }: { color: string; inset?: boolean }) {
  return <View style={[styles.divider, inset && styles.dividerInset, { backgroundColor: color }]} />;
}

function IdentityRow({ icon, label, monospace, value }: { icon: 'network' | 'server.rack' | 'key.horizontal'; label: string; monospace?: boolean; value: string }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.identityRow}>
      <SystemIcon android={icon === 'network' ? 'language' : icon === 'server.rack' ? 'dns' : 'key'} color={colors.textMuted} ios={icon} size={18} />
      <View style={styles.identityCopy}>
        <Text style={[styles.identityLabel, { color: colors.textMuted }]}>{label}</Text>
        <Text selectable numberOfLines={2} style={[styles.identityValue, monospace && styles.monospace, { color: colors.text }]}>{value}</Text>
      </View>
    </View>
  );
}

function stepNumber(step: EnrollmentStep) {
  return step === 'address' ? 1 : step === 'identity' ? 2 : 3;
}

function titleFor(step: EnrollmentStep, t: Translate) {
  if (step === 'address') return t('enroll.addressTitle');
  if (step === 'identity') return t('enroll.identityTitle');
  return t('enroll.credentialsTitle');
}

function descriptionFor(step: EnrollmentStep, t: Translate) {
  if (step === 'address') return isMobileTestMode ? t('enroll.addressDescriptionTest') : t('enroll.addressDescription');
  if (step === 'identity') return t('enroll.identityDescription');
  return t('enroll.credentialsDescription');
}

function messageFor(cause: unknown, t: Translate) {
  if (cause instanceof DirectEnrollmentError) return cause.message;
  return cause instanceof Error ? cause.message : t('enroll.error');
}

const styles = StyleSheet.create({
  progressHeader: { gap: 7, paddingTop: 2 },
  stepLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  title: { fontSize: 30, fontWeight: '700', letterSpacing: -0.7, lineHeight: 36 },
  description: { fontSize: 15, lineHeight: 21 },
  progressTrack: { borderRadius: 2, height: 4, overflow: 'hidden' },
  progressValue: { borderRadius: 2, height: 4 },
  sectionLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.4, marginBottom: -9, marginLeft: 14, marginTop: 8 },
  formGroup: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  inputRow: { alignItems: 'center', flexDirection: 'row', gap: 11, minHeight: 52, paddingHorizontal: 14 },
  input: { flex: 1, fontSize: 16, minHeight: 50, paddingVertical: 10 },
  footnote: { fontSize: 13, lineHeight: 18, marginHorizontal: 14, marginTop: -9 },
  notice: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 9, paddingHorizontal: 12, paddingVertical: 11 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  noticeStrong: { fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth },
  dividerInset: { marginLeft: 44 },
  identityRow: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 61, paddingHorizontal: 14, paddingVertical: 9 },
  identityCopy: { flex: 1, gap: 2 },
  identityLabel: { fontSize: 12, lineHeight: 16 },
  identityValue: { fontSize: 14, lineHeight: 18 },
  monospace: { fontFamily: 'monospace', fontSize: 12 },
  verifiedNote: { alignItems: 'flex-start', flexDirection: 'row', gap: 10, paddingHorizontal: 4 },
  verifiedText: { flex: 1, fontSize: 13, lineHeight: 19 },
  primaryAction: { alignSelf: 'stretch' },
  busyRow: { alignItems: 'center', flexDirection: 'row', gap: 9, justifyContent: 'center', minHeight: 32 },
  busyText: { fontSize: 13 },
  errorGroup: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 9, padding: 12 },
  error: { flex: 1, fontSize: 13, lineHeight: 19 },
});
