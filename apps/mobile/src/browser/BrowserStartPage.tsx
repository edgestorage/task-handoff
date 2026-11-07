import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { browserPageSuggestions, type BrowserPage, type BrowserStartPage as StartPage } from './start-page-store';

export function BrowserStartPage({ page, mode, query, onNavigate, onUnpin, onClear }: {
  page: StartPage;
  mode: 'start' | 'history' | 'suggestions';
  query: string;
  onNavigate(url: string): void;
  onUnpin(page: BrowserPage): void;
  onClear(): void;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const rows = mode === 'suggestions' ? browserPageSuggestions(page, query) : page.recent;
  const row = (item: BrowserPage, pinned = false) => <View key={item.url} style={[styles.row, { borderBottomColor: colors.workbenchCardBorder }]}>
    <Pressable accessibilityRole="button" onPress={() => onNavigate(item.url)} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
      <View style={[styles.siteIcon, { backgroundColor: colors.surfaceInset }]}><Icon color={colors.textMuted} name={pinned ? 'bookmark-outline' : 'time-outline'} size={18} /></View>
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{item.title || new URL(item.url).host}</Text>
        <Text numberOfLines={1} style={[styles.url, { color: colors.textMuted }]}>{item.url}</Text>
      </View>
      {!pinned ? <Icon color={colors.textMuted} name="chevron-forward" size={17} /> : null}
    </Pressable>
    {pinned ? <Pressable accessibilityLabel={t('browser.unpinPage', { title: item.title || item.url })} accessibilityRole="button" onPress={() => onUnpin(item)} style={({ pressed }) => [styles.remove, pressed && styles.pressed]}>
      <Icon color={colors.textMuted} name="close" size={17} />
    </Pressable> : null}
  </View>;

  return <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" style={[styles.root, { backgroundColor: colors.background }]}>
    <View style={styles.column}>
      {mode === 'start' ? <View style={styles.hero}>
        <View style={[styles.heroIcon, { backgroundColor: colors.primarySoft }]}><Icon color={colors.primary} name="globe-outline" size={30} /></View>
        <Text style={[styles.heading, { color: colors.text }]}>{t('browser.startTitle')}</Text>
        <Text style={[styles.description, { color: colors.textMuted }]}>{t('browser.startDescription')}</Text>
      </View> : null}
      {mode === 'start' ? <View style={styles.section}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('browser.pinned')}</Text>
        {page.pinned.length ? <View style={[styles.group, { backgroundColor: colors.surface }]}>{page.pinned.map((item) => row(item, true))}</View>
          : <Text style={[styles.empty, { color: colors.textMuted }]}>{t('browser.noPinned')}</Text>}
      </View> : null}
      <View style={styles.section}>
        <View style={styles.sectionHeading}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.textMuted }]}>{t(mode === 'suggestions' ? 'browser.suggestions' : 'browser.recent')}</Text>
          {mode !== 'suggestions' && page.recent.length ? <Pressable accessibilityRole="button" onPress={onClear} style={({ pressed }) => [styles.clear, pressed && styles.pressed]}><Text style={[styles.clearText, { color: colors.primary }]}>{t('browser.clearRecent')}</Text></Pressable> : null}
        </View>
        {rows.length ? <View style={[styles.group, { backgroundColor: colors.surface }]}>{rows.map((item) => row(item))}</View>
          : <Text style={[styles.empty, { color: colors.textMuted }]}>{t(mode === 'suggestions' ? 'browser.noSuggestions' : 'browser.noRecent')}</Text>}
      </View>
    </View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, content: { alignItems: 'center', paddingHorizontal: 20, paddingBottom: 24, paddingTop: 12 }, column: { maxWidth: 600, width: '100%' },
  hero: { alignItems: 'center', gap: 10, paddingVertical: 28, paddingHorizontal: 12 }, heroIcon: { alignItems: 'center', borderRadius: 20, height: 60, justifyContent: 'center', marginBottom: 6, width: 60 },
  heading: { fontSize: 22, lineHeight: 28, fontWeight: '500', textAlign: 'center' }, description: { fontSize: 14, lineHeight: 21, maxWidth: 300, textAlign: 'center' },
  section: { marginBottom: 16 }, sectionHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 44 }, sectionTitle: { fontSize: 13, fontWeight: '500', lineHeight: 18, paddingHorizontal: 4, paddingVertical: 10 },
  group: { borderRadius: 14, overflow: 'hidden' }, row: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row' },
  link: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 12, minHeight: 70, paddingHorizontal: 12, paddingVertical: 12 }, siteIcon: { alignItems: 'center', borderRadius: 10, height: 36, justifyContent: 'center', width: 36 },
  copy: { flex: 1, gap: 3 }, title: { fontSize: 14, fontWeight: '500', lineHeight: 20 }, url: { fontSize: 12, lineHeight: 17 },
  empty: { fontSize: 13, lineHeight: 19, paddingHorizontal: 4, paddingVertical: 10 }, clear: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 8 }, clearText: { fontSize: 13, lineHeight: 18 }, remove: { alignItems: 'center', justifyContent: 'center', minHeight: 44, width: 44 }, pressed: { opacity: 0.55 },
});
