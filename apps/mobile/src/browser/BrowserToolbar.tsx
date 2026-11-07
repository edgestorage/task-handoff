import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NewSessionContextMenu } from '../ai-sessions/NewSessionContextMenu';
import type { AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';

type Props = {
  canGoBack: boolean;
  canGoForward: boolean;
  connected: boolean;
  creating: boolean;
  pane: boolean;
  tabs: AnchoredSelectOption[];
  selectedTabId: string;
  moreOptions: AnchoredSelectOption[];
  onBack(): void;
  onForward(): void;
  onNew(): void;
  onSelectTab(value: string): void;
  onMore(value: string): void;
};

export function BrowserToolbar(props: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <SafeAreaView edges={props.pane ? [] : ['bottom', 'left', 'right']} style={[styles.footer, { backgroundColor: colors.surface, borderTopColor: colors.workbenchCardBorder }]}>
    <View style={styles.toolbar}>
      <View style={[styles.navigation, { backgroundColor: colors.surfaceInset }]}>
        <NavigationButton disabled={!props.connected || !props.canGoBack} label={t('browser.back')} onPress={props.onBack} direction="back" />
        <View style={[styles.separator, { backgroundColor: colors.workbenchCardBorder }]} />
        <NavigationButton disabled={!props.connected || !props.canGoForward} label={t('browser.forward')} onPress={props.onForward} direction="forward" />
      </View>
      <View style={styles.slot}><ToolbarAction busy={props.creating} disabled={!props.connected || props.creating} label={t('browser.newTab')} onPress={props.onNew} primary>
        {props.creating ? <ActivityIndicator color={colors.primary} size="small" /> : <Icon color={colors.primary} name="add" size={26} />}
      </ToolbarAction></View>
      <View style={styles.slot}><NewSessionContextMenu cancelLabel={t('common.cancel')} onSelect={props.onSelectTab} options={props.tabs} selectedValue={props.selectedTabId} title={t('browser.tabs')}>
        {(onPress) => <ToolbarAction label={t('browser.tabsCount', { count: props.tabs.length })} onPress={onPress}>
          <View style={styles.tabGlyph}>
            <View style={[styles.tabBehind, { borderColor: colors.text }]} />
            <View style={[styles.tabFront, { backgroundColor: colors.surface, borderColor: colors.text }]}><Text style={[styles.tabCount, { color: colors.text }]}>{props.tabs.length > 99 ? '99+' : props.tabs.length}</Text></View>
          </View>
        </ToolbarAction>}
      </NewSessionContextMenu></View>
      <View style={styles.slot}><NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={props.creating} options={props.moreOptions} selectedValue="" title={t('browser.browser')} onSelect={props.onMore}>
        {(onPress) => <ToolbarAction disabled={props.creating} label={t('browser.more')} onPress={onPress}>
          <Icon color={colors.text} name="ellipsis-horizontal" size={23} />
        </ToolbarAction>}
      </NewSessionContextMenu></View>
    </View>
  </SafeAreaView>;
}

function NavigationButton({ direction, disabled, label, onPress }: { direction: 'back' | 'forward'; disabled: boolean; label: string; onPress(): void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.navigationButton, disabled && styles.disabled, pressed && styles.pressed]}>
    <Icon color={colors.text} name={direction === 'back' ? 'chevron-back' : 'chevron-forward'} size={23} />
  </Pressable>;
}

function ToolbarAction({ busy = false, children, disabled = false, label, onPress, primary }: {
  busy?: boolean; children: ReactNode; disabled?: boolean; label: string; onPress?: () => void; primary?: boolean;
}) {
  const { colors } = useMobileTheme();
  // iOS MenuView owns the gesture and intentionally supplies no JS onPress.
  // Only explicit state can disable a native menu trigger.
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ busy, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}>
    <View style={[styles.actionIcon, primary && { backgroundColor: colors.primarySoft }]}>{children}</View>
  </Pressable>;
}

const styles = StyleSheet.create({
  footer: { borderTopWidth: StyleSheet.hairlineWidth },
  toolbar: { alignItems: 'center', alignSelf: 'center', flexDirection: 'row', gap: 4, maxWidth: 600, paddingHorizontal: 12, paddingVertical: 4, width: '100%' },
  navigation: { alignItems: 'center', borderRadius: 14, flexDirection: 'row' },
  navigationButton: { alignItems: 'center', borderRadius: 14, height: 44, justifyContent: 'center', width: 44 }, separator: { height: 18, width: StyleSheet.hairlineWidth },
  slot: { alignItems: 'center', flex: 1, minWidth: 44 },
  action: { alignItems: 'center', borderRadius: 12, height: 44, justifyContent: 'center', width: 44 }, actionIcon: { alignItems: 'center', borderRadius: 12, height: 40, justifyContent: 'center', minWidth: 44 },
  tabGlyph: { height: 26, width: 28 }, tabBehind: { borderRadius: 6, borderWidth: 1.5, height: 22, opacity: 0.4, position: 'absolute', right: 0, top: 0, width: 23 },
  tabFront: { alignItems: 'center', borderRadius: 6, borderWidth: 1.5, bottom: 0, height: 23, justifyContent: 'center', left: 0, minWidth: 24, paddingHorizontal: 2, position: 'absolute' },
  tabCount: { fontSize: 11, fontWeight: '500', lineHeight: 15 }, disabled: { opacity: 0.3 }, pressed: { opacity: 0.55 },
});
