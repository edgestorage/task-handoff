import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import { ScreenFlatList } from '../components/ScreenFlatList';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { mobileLicenseData } from './model';

export function LicenseListScreen() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return mobileLicenseData.packages;
    return mobileLicenseData.packages.filter((item) => [item.name, item.version, item.license]
      .some((value) => value.toLowerCase().includes(normalized)));
  }, [query]);

  return (
    <ScreenFlatList
      contentContainerStyle={styles.content}
      data={filtered}
      initialNumToRender={18}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      keyExtractor={(item) => item.id}
      ListEmptyComponent={<Text style={[styles.empty, { color: colors.textMuted }]}>{t('licenses.noResults')}</Text>}
      ListHeaderComponent={<View style={styles.header}>
        <Text style={[styles.intro, { color: colors.textMuted }]}>{t('licenses.intro')}</Text>
        {!query.trim() ? <Pressable
          accessibilityLabel={t('licenses.projectDetail')}
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/licenses/[licenseId]', params: { licenseId: mobileLicenseData.project.id } } as never)}
          style={({ pressed }) => [styles.project, { backgroundColor: colors.primarySoft, borderColor: colors.border }, pressed && styles.pressed]}
          testID="license-project-row"
        >
          <View style={[styles.projectIcon, { backgroundColor: colors.surface }]}>
            <Icon color={colors.primary} name="cube-outline" size={20} />
          </View>
          <View style={styles.projectCopy}>
            <Text style={[styles.projectName, { color: colors.text }]}>{mobileLicenseData.project.name}</Text>
            <Text style={[styles.projectMeta, { color: colors.textMuted }]}>{mobileLicenseData.project.license} · {t('licenses.applicationLicense')}</Text>
          </View>
          <Icon color={colors.textMuted} name="chevron-forward" size={13} />
        </Pressable> : null}
        <View style={[styles.search, { backgroundColor: colors.surfaceInset, borderColor: colors.border }]}>
          <Icon color={colors.textMuted} name="search-outline" size={17} />
          <TextInput
            accessibilityLabel={t('licenses.searchPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder={t('licenses.searchPlaceholder')}
            placeholderTextColor={colors.textMuted}
            style={[styles.searchInput, { color: colors.text }]}
            value={query}
          />
        </View>
        <Text style={[styles.count, { color: colors.textMuted }]}>{t('licenses.packageCount', { count: filtered.length })}</Text>
      </View>}
      renderItem={({ item }) => (
        <Pressable
          accessibilityLabel={`${item.name} ${item.version}, ${item.license}`}
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/licenses/[licenseId]', params: { licenseId: item.id } } as never)}
          style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && { backgroundColor: colors.surfaceInset }]}
          testID="license-package-row"
        >
          <View style={styles.rowCopy}>
            <Text numberOfLines={2} style={[styles.packageName, { color: colors.text }]}>{item.name}</Text>
            <Text numberOfLines={1} style={[styles.packageMeta, { color: colors.textMuted }]}>{item.version} · {item.license}</Text>
          </View>
          <Icon color={colors.textMuted} name="chevron-forward" size={13} />
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: { gap: 8, paddingBottom: 28, paddingHorizontal: 16, paddingTop: 14 },
  header: { gap: 12, paddingBottom: 4 },
  intro: { fontSize: 13, lineHeight: 19 },
  project: { alignItems: 'center', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, padding: 13 },
  projectIcon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 },
  projectCopy: { flex: 1, gap: 3 },
  projectName: { fontSize: 15, fontWeight: '500' },
  projectMeta: { fontSize: 12, lineHeight: 17 },
  search: { alignItems: 'center', borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, minHeight: 42, paddingHorizontal: 12 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 9 },
  count: { fontSize: 12 },
  row: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, minHeight: 58, paddingHorizontal: 13, paddingVertical: 10 },
  rowCopy: { flex: 1, gap: 3 },
  packageName: { fontSize: 14, fontWeight: '500', lineHeight: 19 },
  packageMeta: { fontSize: 12, lineHeight: 17 },
  empty: { fontSize: 14, paddingHorizontal: 24, paddingVertical: 40, textAlign: 'center' },
  pressed: { opacity: 0.72 },
});
