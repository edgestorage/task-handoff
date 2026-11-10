import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { AnchoredSelectMenu, type AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import { Icon, type IconName } from '../components/Icon';
import { useI18n } from '../i18n';
import type { RemoteDesktopMouseMode } from './preferences';
import type { RemoteDesktopSnapshot } from './types';

type Props = {
  bottomInset: number;
  keyboardVisible: boolean;
  mouseMode: RemoteDesktopMouseMode;
  onInput(): void;
  onKeyboard(): void;
  onMouseMode(value: RemoteDesktopMouseMode): void;
  snapshot: RemoteDesktopSnapshot;
};

export function RemoteDesktopToolbar(props: Props) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const { snapshot } = props;
  const canControl = snapshot.phase === 'connected' || snapshot.phase === 'paused' || Boolean(snapshot.path);
  const inputBusy = snapshot.inputPending || snapshot.controlRequestPending;
  const inputLabel = snapshot.inputEnabled
    ? t('remoteDesktop.disableInput')
    : !snapshot.isController
      ? t('remoteDesktop.requestControl')
      : t('remoteDesktop.enableInput');
  const inputText = snapshot.inputEnabled
    ? t('remoteDesktop.toolbarStopInput')
    : !snapshot.isController
      ? t('remoteDesktop.toolbarControl')
      : t('remoteDesktop.toolbarInput');
  const keyboardText = props.keyboardVisible ? t('remoteDesktop.toolbarHideKeyboard') : t('remoteDesktop.toolbarKeyboard');
  const mouseOptions: AnchoredSelectOption<RemoteDesktopMouseMode>[] = [
    { description: t('remoteDesktop.directTouchDescription'), value: 'direct', label: t('remoteDesktop.directTouch'), systemImage: 'hand.tap' },
    { description: t('remoteDesktop.trackpadDescription'), value: 'trackpad', label: t('remoteDesktop.trackpad'), systemImage: 'rectangle.and.hand.point.up.left' },
  ];

  if (collapsed) return <View style={[styles.collapsedRoot, { bottom: Math.max(10, props.bottomInset + 8) }]}>
    <Pressable accessibilityLabel={t('remoteDesktop.showToolbar')} accessibilityRole="button" onPress={() => setCollapsed(false)} style={({ pressed }) => [styles.collapsedButton, pressed && styles.pressed]}>
      <Icon color={TOOLBAR_MUTED} name="chevron-up" size={19} />
    </Pressable>
  </View>;

  return <View style={[styles.root, { bottom: Math.max(8, props.bottomInset + 6) }]}>
    <ToolbarButton active={snapshot.inputEnabled} busy={inputBusy} disabled={!canControl} icon={snapshot.inputEnabled ? 'hand-left' : 'hand-left-outline'} label={inputLabel} text={inputText} onPress={props.onInput} />
    <ToolbarButton active={props.keyboardVisible} disabled={!snapshot.inputEnabled} icon="keypad-outline" label={props.keyboardVisible ? t('remoteDesktop.hideKeyboard') : t('remoteDesktop.keyboard')} text={keyboardText} onPress={props.onKeyboard} />
    <AnchoredSelectMenu
      cancelLabel={t('common.cancel')}
      disabled={!snapshot.inputEnabled}
      onSelect={props.onMouseMode}
      options={mouseOptions}
      selectedValue={props.mouseMode}
      title={t('remoteDesktop.mouseMode')}
    >
      {(open) => <ToolbarButton active={props.mouseMode === 'trackpad'} disabled={!snapshot.inputEnabled} icon={props.mouseMode === 'direct' ? 'radio-button-on-outline' : 'ellipse-outline'} label={t('remoteDesktop.mouseMode')} text={t('remoteDesktop.toolbarMouse')} onPress={open} />}
    </AnchoredSelectMenu>
    <Pressable accessibilityLabel={t('remoteDesktop.hideToolbar')} accessibilityRole="button" hitSlop={8} onPress={() => setCollapsed(true)} style={({ pressed }) => [styles.collapseButton, pressed && styles.pressed]}>
      <Icon color={TOOLBAR_MUTED} name="chevron-down" size={16} />
    </Pressable>
  </View>;
}

function ToolbarButton({ active = false, busy = false, disabled = false, icon, label, text, onPress }: {
  active?: boolean; busy?: boolean; disabled?: boolean; icon: IconName; label: string; text: string; onPress?: () => void;
}) {
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ busy, disabled, selected: active }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}>
    <View style={[styles.icon, active && styles.iconActive]}>
      {busy ? <ActivityIndicator color={TOOLBAR_ACTIVE} size="small" /> : <Icon color={active ? TOOLBAR_ACTIVE : TOOLBAR_INACTIVE} name={icon} size={21} />}
    </View>
    <Text numberOfLines={1} style={[styles.label, { color: active ? TOOLBAR_ACTIVE : TOOLBAR_MUTED }]}>{text}</Text>
  </Pressable>;
}

const TOOLBAR_ACTIVE = '#9fd2ff';
const TOOLBAR_INACTIVE = 'rgba(255,255,255,0.88)';
const TOOLBAR_MUTED = 'rgba(255,255,255,0.58)';

const styles = StyleSheet.create({
  root: { alignItems: 'center', alignSelf: 'center', backgroundColor: 'rgba(24,25,29,0.94)', borderColor: 'rgba(255,255,255,0.14)', borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 1, maxWidth: 430, paddingHorizontal: 4, paddingVertical: 5, position: 'absolute', shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 18, width: '92%' },
  action: { alignItems: 'center', flex: 1, justifyContent: 'center', minHeight: 54, paddingHorizontal: 2 },
  icon: { alignItems: 'center', borderRadius: 10, height: 30, justifyContent: 'center', width: 38 },
  iconActive: { backgroundColor: 'rgba(91,161,255,0.18)' },
  label: { fontSize: 12, lineHeight: 15, marginTop: 2, textAlign: 'center' },
  collapseButton: { alignItems: 'center', height: 38, justifyContent: 'center', width: 22 },
  disabled: { opacity: 0.34 },
  pressed: { opacity: 0.55 },
  collapsedRoot: { alignItems: 'center', position: 'absolute', right: 14 },
  collapsedButton: { alignItems: 'center', backgroundColor: 'rgba(24,25,29,0.94)', borderColor: 'rgba(255,255,255,0.14)', borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, height: 40, justifyContent: 'center', width: 40 },
});
