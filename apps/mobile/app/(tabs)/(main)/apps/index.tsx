import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import { AppSessionList } from '../../../../src/app-sessions/AppSessionList';
import { BrowserTabList } from '../../../../src/browser/BrowserTabList';
import { useActiveAppSessions } from '../../../../src/app-sessions/use-active-app-sessions';
import { useActiveDirectories } from '../../../../src/directories/use-directories';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';
import { useMobileTheme } from '../../../../src/components/theme';
import { useI18n } from '../../../../src/i18n';
export default function AppsRoute() {
  const { closeSession, refresh, state } = useActiveAppSessions();
  const { state: directory } = useActiveDirectories();
  const { scope } = useInstanceScope();
  const { colors } = useMobileTheme();
  const [section, setSection] = useState<'apps' | 'browser'>('apps');
  return <View style={[styles.root, { backgroundColor: colors.background }]}>
    {section === 'browser'
      ? <BrowserTabList directory={directory} header={<SectionTabs section={section} onChange={setSection} />} scope={scope} />
      : <AppSessionList directory={directory} header={<SectionTabs section={section} onChange={setSection} />} onCloseSession={closeSession} onRefresh={refresh} scope={scope} state={state} />}
  </View>;
}

function SectionTabs({ section, onChange }: { section: 'apps' | 'browser'; onChange(value: 'apps' | 'browser'): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [trackWidth, setTrackWidth] = useState(0);
  const [offset] = useState(() => new Animated.Value(0));
  const tabPadding = 3;
  const optionWidth = Math.max(0, (trackWidth - tabPadding * 2) / 2);
  useEffect(() => {
    if (!optionWidth) return;
    const animation = Animated.spring(offset, {
      damping: 24,
      mass: 0.75,
      stiffness: 260,
      toValue: (section === 'browser' ? 1 : 0) * optionWidth,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [offset, optionWidth, section]);
  return <View style={styles.tabsHeader}>
    <View accessibilityRole="tablist" onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)} style={[styles.tabs, { backgroundColor: colors.surfaceMuted }]}>
      {optionWidth > 0 ? <Animated.View pointerEvents="none" style={[styles.tabSelection, { backgroundColor: colors.surface, transform: [{ translateX: offset }], width: optionWidth }]} /> : null}
      {([['apps', t('nav.appSessions')], ['browser', t('browser.sessions')]] as const).map(([value, label]) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: section === value }} key={value} onPress={() => onChange(value)} style={styles.tab}>
        <Text style={[styles.tabLabel, { color: section === value ? colors.text : colors.textMuted }]}>{label}</Text>
      </Pressable>)}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  tabsHeader: { paddingBottom: 12, paddingHorizontal: 20, paddingTop: 16 },
  tabs: { borderRadius: 999, flexDirection: 'row', padding: 3, position: 'relative', width: '100%' },
  tabSelection: { borderRadius: 999, bottom: 3, left: 3, position: 'absolute', top: 3 },
  tab: { alignItems: 'center', borderRadius: 999, flex: 1, justifyContent: 'center', minHeight: 34, paddingHorizontal: 4, zIndex: 1 },
  tabLabel: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
});
