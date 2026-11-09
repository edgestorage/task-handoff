import { useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import type { TotpEnrollmentResponse } from '@task-handoff/cloud-contracts/mobile';

import { OneTimeCodeInput } from '../components/OneTimeCodeInput';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { errorHaptic, successHaptic } from '../platform/haptics';
import type { CloudAccountSecurityController } from './use-cloud-account-security';

type Props = { controller: CloudAccountSecurityController; enrollment: TotpEnrollmentResponse };
type Notice = { tone: 'success' | 'error'; text: string };

export function TotpEnrollmentPanel({ controller, enrollment }: Props) {
  return <TotpEnrollmentPanelContent key={enrollment.enrollmentToken} controller={controller} enrollment={enrollment}/>;
}

function TotpEnrollmentPanelContent({ controller, enrollment }: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  const [revealed, setRevealed] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [now, setNow] = useState<number>();
  const remainingSeconds = now === undefined ? undefined : remainingEnrollmentSeconds(enrollment.expiresAt, now);
  const expired = remainingSeconds !== undefined && remainingSeconds <= 0;
  const qrSize = Math.max(168, Math.min(220, Math.floor(width - 96)));

  useEffect(() => {
    const update = () => setNow(Date.now());
    const initial = setTimeout(update, 0);
    const timer = setInterval(update, 1_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 2_500);
    return () => clearTimeout(timer);
  }, [notice]);

  async function copySecret() {
    try {
      await Clipboard.setStringAsync(enrollment.secret);
      successHaptic();
      setNotice({ tone: 'success', text: t('cloudAccount.totpSecretCopied') });
    } catch {
      errorHaptic();
      setNotice({ tone: 'error', text: t('cloudAccount.totpCopyFailed') });
    }
  }

  async function openAuthenticator() {
    try {
      await Linking.openURL(enrollment.otpauthUri);
      successHaptic();
    } catch {
      errorHaptic();
      setNotice({ tone: 'error', text: t('cloudAccount.totpOpenFailed') });
    }
  }

  return <View style={styles.content} testID="totp-enrollment-panel">
    <Text style={[styles.description, { color: colors.textMuted }]}>{t('cloudAccount.totpEnrollDescription')}</Text>

    <View accessible accessibilityLabel={t('cloudAccount.totpQrLabel')} style={styles.qrFrame}>
      <QRCode
        backgroundColor="#ffffff"
        color="#000000"
        ecl="M"
        quietZone={10}
        size={qrSize}
        testID="totp-enrollment-qr"
        value={enrollment.otpauthUri}
      />
    </View>
    <Text style={[styles.hint, { color: colors.textMuted }]}>{t('cloudAccount.totpQrHint')}</Text>

    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.textMuted }]}>{t('cloudAccount.totpSecret')}</Text>
      <Text selectable style={[styles.secret, { color: colors.text }]}>{revealed ? formatSecret(enrollment.secret) : '•••• •••• •••• ••••'}</Text>
      <View style={styles.inlineActions}>
        <TextAction label={t(revealed ? 'cloudAccount.totpHideSecret' : 'cloudAccount.totpShowSecret')} onPress={() => setRevealed((value) => !value)}/>
        <TextAction label={t('cloudAccount.totpCopySecret')} onPress={() => void copySecret()}/>
        <TextAction label={t('cloudAccount.totpOpenAuthenticator')} onPress={() => void openAuthenticator()}/>
      </View>
    </View>

    <View style={[styles.validity, { backgroundColor: expired ? colors.errorSoft : colors.surface }]}>
      <Text style={[styles.validityText, { color: expired ? colors.error : colors.textMuted }]}>
        {remainingSeconds === undefined
          ? t('cloudAccount.totpPreparing')
          : t(expired ? 'cloudAccount.totpExpired' : 'cloudAccount.totpExpiresIn', { time: formatRemaining(remainingSeconds) })}
      </Text>
    </View>

    {notice ? <Text accessibilityLiveRegion="polite" style={[styles.notice, { color: notice.tone === 'error' ? colors.error : colors.sessionActive }]}>{notice.text}</Text> : null}
    {controller.message ? <Text accessibilityLiveRegion="polite" style={[styles.notice, { color: colors.error }]}>{controller.message}</Text> : null}

    <Text style={[styles.label, { color: colors.textMuted }]}>{t('cloudAccount.totpCode')}</Text>
    <OneTimeCodeInput
      accessibilityLabel={t('cloudAccount.totpCode')}
      disabled={controller.busy || expired}
      focusKey={controller.totpFocusKey}
      onChangeText={controller.setTotpCode}
      onComplete={(code) => controller.confirmTotp(code)}
      value={controller.totpCode}
    />
    <Pressable
      accessibilityLabel={t('cloudAccount.confirmAuthenticator')}
      accessibilityRole="button"
      accessibilityState={{ disabled: controller.busy || expired || controller.totpCode.length !== 6 }}
      disabled={controller.busy || expired || controller.totpCode.length !== 6}
      onPress={() => controller.confirmTotp()}
      style={({ pressed }) => [
        styles.primaryAction,
        { backgroundColor: colors.primary },
        (controller.busy || expired || controller.totpCode.length !== 6) && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {controller.busy ? <ActivityIndicator color="#ffffff"/> : null}
      <Text style={styles.primaryActionText}>{t('cloudAccount.confirmAuthenticator')}</Text>
    </Pressable>

    {expired ? <TextAction align="center" label={t('cloudAccount.totpRestart')} onPress={controller.cancelTotpEnrollment}/> : null}
    <TextAction align="center" label={t('common.cancel')} onPress={controller.cancelTotpEnrollment}/>
  </View>;
}

function TextAction({ align = 'leading', label, onPress }: { align?: 'leading' | 'center'; label: string; onPress(): void }) {
  const { colors } = useMobileTheme();
  return <Pressable
    accessibilityLabel={label}
    accessibilityRole="button"
    onPress={onPress}
    style={({ pressed }) => [styles.textAction, align === 'center' && styles.textActionCentered, pressed && styles.pressed]}
  >
    <Text style={[styles.textActionLabel, { color: colors.primary }]}>{label}</Text>
  </Pressable>;
}

export function remainingEnrollmentSeconds(expiresAt: string, now = Date.now()) {
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration)) return 0;
  return Math.max(0, Math.ceil((expiration - now) / 1_000));
}

export function formatRemaining(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function formatSecret(secret: string) {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

const styles = StyleSheet.create({
  content: { alignSelf: 'center', gap: 16, maxWidth: 480, width: '100%' },
  description: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  qrFrame: { alignSelf: 'center', backgroundColor: '#ffffff', borderRadius: 16, padding: 12 },
  hint: { fontSize: 12, lineHeight: 17, textAlign: 'center' },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 14 },
  label: { fontSize: 12, fontWeight: '500', lineHeight: 16 },
  secret: { fontFamily: 'monospace', fontSize: 15, lineHeight: 21 },
  inlineActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, paddingTop: 2 },
  textAction: { justifyContent: 'center', minHeight: 44 },
  textActionCentered: { alignItems: 'center' },
  textActionLabel: { fontSize: 14 },
  validity: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  validityText: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  notice: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  primaryAction: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 50, paddingHorizontal: 18 },
  primaryActionText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
