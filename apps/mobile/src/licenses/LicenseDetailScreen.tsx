import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { openAppBrowser } from '../browser/app-browser';
import { licenseSubject, mobileLicenseData } from './model';

export function LicenseDetailScreen() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { licenseId } = useLocalSearchParams<{ licenseId?: string }>();
  const subject = licenseId ? licenseSubject(licenseId) : undefined;

  if (!subject) {
    return (
      <Screen>
        <Text style={[styles.notFound, { color: colors.textMuted }]}>{t('licenses.notFound')}</Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
          <Text style={[styles.backText, { color: colors.primary }]}>{t('licenses.backToLicenses')}</Text>
        </Pressable>
      </Screen>
    );
  }

  const packageInfo = 'version' in subject ? subject : undefined;
  const openHomepage = () => {
    if (!packageInfo?.homepage) return;
    void openAppBrowser(packageInfo.homepage).catch(() => {
      Alert.alert(t('licenses.title'), t('about.openFailed'));
    });
  };

  return (
    <>
      <Stack.Screen options={{ title: subject.name }} />
      <Screen testID="license-detail-screen">
        <View style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.name, { color: colors.text }]}>{subject.name}</Text>
          {packageInfo ? <Text style={[styles.version, { color: colors.textMuted }]}>{t('licenses.versionValue', { version: packageInfo.version })}</Text> : null}
          <Text style={[styles.license, { color: colors.primary }]}>{subject.license}</Text>
          {packageInfo?.author ? <Text style={[styles.meta, { color: colors.textMuted }]}>{t('licenses.authorValue', { author: packageInfo.author })}</Text> : null}
          {packageInfo?.homepage ? (
            <Pressable accessibilityRole="link" onPress={openHomepage} style={({ pressed }) => [styles.homepage, pressed && styles.pressed]}>
              <Text numberOfLines={1} style={[styles.homepageText, { color: colors.primary }]}>{packageInfo.homepage}</Text>
              <Icon color={colors.primary} name="open-outline" size={14} />
            </Pressable>
          ) : null}
        </View>

        <Text style={[styles.note, { color: colors.textMuted }]}>{t('licenses.bundledNote')}</Text>
        {subject.texts.map((reference, index) => {
          const content = mobileLicenseData.texts[reference.id];
          if (!content) return null;
          return (
            <View key={`${reference.id}:${index}`} style={styles.textBlock}>
              <Text accessibilityRole="header" style={[styles.textTitle, { color: colors.text }]}>{t(reference.kind === 'notice' ? 'licenses.noticeText' : 'licenses.licenseText')}</Text>
              {reference.source === 'spdx' ? <Text style={[styles.spdxNote, { color: colors.textMuted }]}>{t('licenses.spdxNote')}</Text> : null}
              <Text selectable style={[styles.legalText, { color: colors.text }]}>{content}</Text>
            </View>
          );
        })}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  summary: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 5, padding: 15 },
  name: { fontSize: 17, fontWeight: '500', lineHeight: 23 },
  version: { fontSize: 12 },
  license: { fontSize: 13, fontWeight: '500' },
  meta: { fontSize: 12, lineHeight: 17 },
  homepage: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 3 },
  homepageText: { flexShrink: 1, fontSize: 12 },
  pressed: { opacity: 0.65 },
  note: { fontSize: 12, lineHeight: 18 },
  textBlock: { gap: 8 },
  textTitle: { fontSize: 15, fontWeight: '500' },
  spdxNote: { fontSize: 12, lineHeight: 17 },
  legalText: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
  notFound: { fontSize: 14, paddingVertical: 24, textAlign: 'center' },
  backButton: { alignSelf: 'center', padding: 12 },
  backText: { fontSize: 14, fontWeight: '500' },
});
