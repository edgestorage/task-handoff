import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Alert, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { Screen } from '../components/Screen';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { mobileAppInfo } from '../app-info/version';
import { openAppBrowser } from '../browser/app-browser';
import { legalPageUrl, type LegalDocument } from '../legal/links';
import { mobileCloudEnvironment } from '../platform/build-variant';

const DOCS_URL = 'https://docs.thandoff.com';
const CHANGELOG_URL = 'https://github.com/edgestorage/task-handoff/releases';
const CONTACT_EMAIL = 'privacy@thandoff.com';

export function AboutScreen() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const version = mobileAppInfo.version
    ? mobileAppInfo.build
      ? t('about.versionWithBuild', { version: mobileAppInfo.version, build: mobileAppInfo.build })
      : t('about.version', { version: mobileAppInfo.version })
    : t('about.versionUnavailable');
  const statusUrl = cloudStatusUrl();

  const openPage = (url: string) => {
    void openAppBrowser(url).catch(() => {
      Alert.alert(t('about.title'), t('about.openFailed'));
    });
  };
  const openLegal = (document: LegalDocument) => openPage(legalPageUrl(document, locale));
  const openEmail = () => {
    void Linking.openURL(`mailto:${CONTACT_EMAIL}`).catch(() => {
      Alert.alert(t('about.title'), t('about.openFailed'));
    });
  };

  return (
    <Screen testID="about-screen">
      <View style={[styles.hero, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Image accessibilityIgnoresInvertColors source={require('../../assets/icon.png')} style={styles.icon} />
        <Text style={[styles.product, { color: colors.text }]}>{mobileAppInfo.name}</Text>
        <Text style={[styles.tagline, { color: colors.textMuted }]}>{t('about.tagline')}</Text>
        <Text style={[styles.version, { color: colors.textMuted }]}>{version}</Text>
      </View>

      <InfoSection title={t('about.legal')}>
        <LinkRow
          detail={t('about.privacyDetail')}
          icon="shield-checkmark-outline"
          label={t('about.privacy')}
          onPress={() => openLegal('privacy')}
          testID="about-privacy"
        />
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <LinkRow
          detail={t('about.termsDetail')}
          icon="document-text-outline"
          label={t('about.terms')}
          onPress={() => openLegal('terms')}
          testID="about-terms"
        />
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <LinkRow
          detail={t('about.licensesDetail')}
          icon="code-slash-outline"
          label={t('about.licenses')}
          onPress={() => router.push('/licenses' as never)}
          testID="about-licenses"
        />
      </InfoSection>

      <InfoSection title={t('about.resources')}>
        <LinkRow icon="book-outline" label={t('about.docs')} onPress={() => openPage(DOCS_URL)} testID="about-docs" />
        {statusUrl ? <>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <LinkRow icon="pulse-outline" label={t('about.status')} onPress={() => openPage(statusUrl)} testID="about-status" />
        </> : null}
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <LinkRow icon="time-outline" label={t('about.changelog')} onPress={() => openPage(CHANGELOG_URL)} testID="about-changelog" />
      </InfoSection>

      <InfoSection title={t('about.contact')}>
        <LinkRow detail={CONTACT_EMAIL} icon="mail-outline" label={t('about.contactTitle')} onPress={openEmail} testID="about-contact" />
      </InfoSection>

      <Text style={[styles.copyright, { color: colors.textMuted }]}>{t('about.copyright', { year: new Date().getFullYear() })}</Text>
    </Screen>
  );
}

function cloudStatusUrl() {
  try {
    return new URL('/status', mobileCloudEnvironment.serviceOrigin).toString();
  } catch {
    return undefined;
  }
}

function InfoSection({ children, title }: { children: ReactNode; title: string }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.textMuted }]}>{title}</Text>
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>
    </View>
  );
}

function LinkRow({ detail, icon, label, onPress, testID }: {
  detail?: string;
  icon: IconName;
  label: string;
  onPress(): void;
  testID: string;
}) {
  const { colors } = useMobileTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceInset }]}
      testID={testID}
    >
      <Icon color={colors.textMuted} name={icon} size={19} />
      <View style={styles.rowCopy}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
        {detail ? <Text style={[styles.rowDetail, { color: colors.textMuted }]}>{detail}</Text> : null}
      </View>
      <Icon color={colors.textMuted} name="chevron-forward" size={13} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, gap: 8, paddingHorizontal: 20, paddingVertical: 24 },
  icon: { borderRadius: 16, height: 64, width: 64 },
  product: { fontSize: 21, fontWeight: '600', letterSpacing: -0.3 },
  tagline: { fontSize: 13, lineHeight: 19, maxWidth: 320, textAlign: 'center' },
  version: { fontSize: 12, marginTop: 2 },
  section: { gap: 7 },
  sectionTitle: { fontSize: 12, fontWeight: '500', letterSpacing: 0.4, paddingHorizontal: 4 },
  group: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 52, paddingHorizontal: 14, paddingVertical: 9 },
  rowCopy: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 15, fontWeight: '500' },
  rowDetail: { fontSize: 12, lineHeight: 17 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 45 },
  copyright: { fontSize: 12, paddingBottom: 8, textAlign: 'center' },
});
