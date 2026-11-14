import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import {
  EMPTY_REMOTE_DESKTOP_MODIFIER_STATE,
  REMOTE_DESKTOP_MODIFIER_KEYS,
  REMOTE_DESKTOP_VIRTUAL_KEYBOARD_PAGES,
  activeRemoteDesktopModifiers,
  lockRemoteDesktopModifier,
  releaseArmedRemoteDesktopModifiers,
  remoteDesktopModifierBitMask,
  remoteDesktopModifierKeys,
  tapRemoteDesktopModifier,
  type RemoteDesktopKeyboardMode,
  type RemoteDesktopModifierState,
  type RemoteDesktopVirtualKey,
  type RemoteDesktopVirtualKeyboardPage,
} from './virtual-keyboard';

const ACCENT = '#9fd2ff';
const KEY_LABEL = 'rgba(255,255,255,0.88)';
const KEY_MUTED = 'rgba(255,255,255,0.52)';

type SendKey = (code: string, down: boolean, modifiers?: number, repeat?: boolean) => void;

type KeyboardBarProps = {
  mode: RemoteDesktopKeyboardMode;
  onCollapse(): void;
  onMode(mode: RemoteDesktopKeyboardMode): void;
};

export function RemoteDesktopKeyboardBar({ mode, onCollapse, onMode }: KeyboardBarProps) {
  const { t } = useI18n();
  return <View style={styles.bar}>
    <View accessibilityRole="tablist" style={styles.modeSwitch}>
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: mode === 'system' }}
        onPress={() => onMode('system')}
        style={({ pressed }) => [styles.modeButton, mode === 'system' && styles.modeButtonActive, pressed && styles.pressed]}
      >
        <Icon color={mode === 'system' ? ACCENT : KEY_MUTED} name="keypad" size={15} />
        <Text numberOfLines={1} style={[styles.modeLabel, mode === 'system' && styles.modeLabelActive]}>{t('remoteDesktop.systemKeyboard')}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: mode === 'virtual' }}
        onPress={() => onMode('virtual')}
        style={({ pressed }) => [styles.modeButton, mode === 'virtual' && styles.modeButtonActive, pressed && styles.pressed]}
      >
        <Icon color={mode === 'virtual' ? ACCENT : KEY_MUTED} name="keypad-outline" size={15} />
        <Text numberOfLines={1} style={[styles.modeLabel, mode === 'virtual' && styles.modeLabelActive]}>{t('remoteDesktop.virtualKeyboard')}</Text>
      </Pressable>
    </View>
    <Pressable
      accessibilityLabel={t('remoteDesktop.hideKeyboard')}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onCollapse}
      style={({ pressed }) => [styles.collapseButton, pressed && styles.pressed]}
      testID="remote-desktop-keyboard-collapse"
    >
      <Icon color={KEY_MUTED} name="chevron-down" size={19} />
    </Pressable>
  </View>;
}

type VirtualKeyboardProps = {
  bottomInset: number;
  enabled: boolean;
  mode?: RemoteDesktopKeyboardMode;
  onCollapse(): void;
  onMode(mode: RemoteDesktopKeyboardMode): void;
  sendKey: SendKey;
};

export function RemoteDesktopVirtualKeyboard(props: VirtualKeyboardProps) {
  const { t } = useI18n();
  const [page, setPage] = useState<RemoteDesktopVirtualKeyboardPage>('fn');
  const [modifiers, setModifiers] = useState<RemoteDesktopModifierState>(EMPTY_REMOTE_DESKTOP_MODIFIER_STATE);
  const modifiersRef = useRef(modifiers);
  const pressedKeys = useRef(new Set<string>());
  const sendKeyRef = useRef(props.sendKey);
  const enabledRef = useRef(props.enabled);

  useEffect(() => {
    sendKeyRef.current = props.sendKey;
  }, [props.sendKey]);

  const releaseModifierState = useCallback((state: RemoteDesktopModifierState) => {
    const active = activeRemoteDesktopModifiers(state);
    for (const modifier of active) {
      sendKeyRef.current(REMOTE_DESKTOP_MODIFIER_KEYS[modifier].code, false, 0);
    }
  }, []);

  const resetRemoteKeys = useCallback(() => {
    for (const code of pressedKeys.current) sendKeyRef.current(code, false, 0);
    pressedKeys.current.clear();
    releaseModifierState(modifiersRef.current);
    modifiersRef.current = EMPTY_REMOTE_DESKTOP_MODIFIER_STATE;
  }, [releaseModifierState]);

  useEffect(() => {
    const wasEnabled = enabledRef.current;
    enabledRef.current = props.enabled;
    if (wasEnabled && !props.enabled) resetRemoteKeys();
  }, [props.enabled, resetRemoteKeys]);

  useEffect(() => () => resetRemoteKeys(), [resetRemoteKeys]);

  const updateModifiers = (next: RemoteDesktopModifierState) => {
    modifiersRef.current = next;
    setModifiers(next);
  };

  const pressModifier = (key: RemoteDesktopVirtualKey) => {
    if (!props.enabled || !key.modifier) return;
    const update = tapRemoteDesktopModifier(modifiersRef.current, key.modifier);
    updateModifiers(update.state);
    sendKeyRef.current(key.code, update.down, remoteDesktopModifierBitMask(update.state));
  };

  const lockModifier = (key: RemoteDesktopVirtualKey) => {
    if (!props.enabled || !key.modifier) return;
    const update = lockRemoteDesktopModifier(modifiersRef.current, key.modifier);
    updateModifiers(update.state);
    if (update.down) sendKeyRef.current(key.code, true, remoteDesktopModifierBitMask(update.state));
  };

  const pressKey = (key: RemoteDesktopVirtualKey) => {
    if (!props.enabled || pressedKeys.current.has(key.code)) return;
    pressedKeys.current.add(key.code);
    sendKeyRef.current(key.code, true, remoteDesktopModifierBitMask(modifiersRef.current));
  };

  const releaseKey = (key: RemoteDesktopVirtualKey) => {
    if (!pressedKeys.current.delete(key.code)) return;
    sendKeyRef.current(key.code, false, remoteDesktopModifierBitMask(modifiersRef.current));
    const released = releaseArmedRemoteDesktopModifiers(modifiersRef.current);
    if (!released.released.length) return;
    updateModifiers(released.state);
    const nextMask = remoteDesktopModifierBitMask(released.state);
    for (const modifier of released.released) {
      sendKeyRef.current(REMOTE_DESKTOP_MODIFIER_KEYS[modifier].code, false, nextMask);
    }
  };

  const pageDefinition = REMOTE_DESKTOP_VIRTUAL_KEYBOARD_PAGES.find((candidate) => candidate.id === page)
    ?? REMOTE_DESKTOP_VIRTUAL_KEYBOARD_PAGES[0];

  return <View style={[styles.dock, { paddingBottom: Math.max(4, props.bottomInset) }]} testID="remote-desktop-virtual-keyboard">
    <RemoteDesktopKeyboardBar mode={props.mode ?? 'virtual'} onCollapse={props.onCollapse} onMode={props.onMode} />
    <View accessibilityRole="tablist" style={styles.pages}>
      {REMOTE_DESKTOP_VIRTUAL_KEYBOARD_PAGES.map((candidate) => <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: candidate.id === page }}
        key={candidate.id}
        onPress={() => setPage(candidate.id)}
        style={({ pressed }) => [styles.pageButton, candidate.id === page && styles.pageButtonActive, pressed && styles.pressed]}
      >
        <Text style={[styles.pageLabel, candidate.id === page && styles.pageLabelActive]}>{candidate.label}</Text>
      </Pressable>)}
    </View>
    <View style={styles.modifierRow}>
      {remoteDesktopModifierKeys().map((key) => {
        const modifierState = key.modifier ? modifiers[key.modifier] : undefined;
        const keyDefinition = key.modifier === 'meta'
          ? { ...key, label: Platform.OS === 'ios' ? '⌘' : 'Win', accessibilityLabel: Platform.OS === 'ios' ? 'Command' : 'Windows' }
          : key;
        return <KeyButton
          accessibilityHint={key.modifier ? t('remoteDesktop.modifierKeyHint') : undefined}
          active={Boolean(modifierState && modifierState !== 'off')}
          disabled={!props.enabled}
          key={key.code}
          keyDefinition={keyDefinition}
          locked={modifierState === 'locked'}
          onLongPress={key.modifier ? () => lockModifier(key) : undefined}
          onPressIn={() => key.modifier ? pressModifier(key) : pressKey(key)}
          onPressOut={key.modifier ? undefined : () => releaseKey(key)}
        />;
      })}
    </View>
    <View style={styles.keys}>
      {pageDefinition.rows.map((row, rowIndex) => <View key={`${pageDefinition.id}-${rowIndex}`} style={styles.keyRow}>
        {row.map((key) => <KeyButton
          disabled={!props.enabled}
          key={`${pageDefinition.id}-${rowIndex}-${key.code}`}
          keyDefinition={key}
          onPressIn={() => pressKey(key)}
          onPressOut={() => releaseKey(key)}
        />)}
      </View>)}
    </View>
  </View>;
}

function KeyButton({ accessibilityHint, active = false, disabled, keyDefinition, locked = false, onLongPress, onPressIn, onPressOut }: {
  accessibilityHint?: string;
  active?: boolean;
  disabled: boolean;
  keyDefinition: RemoteDesktopVirtualKey;
  locked?: boolean;
  onLongPress?(): void;
  onPressIn(): void;
  onPressOut?(): void;
}) {
  return <Pressable
    accessibilityHint={accessibilityHint}
    accessibilityLabel={keyDefinition.accessibilityLabel ?? keyDefinition.label}
    accessibilityRole="button"
    accessibilityState={{ disabled, selected: active }}
    delayLongPress={450}
    disabled={disabled}
    onLongPress={onLongPress}
    onPressIn={onPressIn}
    onPressOut={onPressOut}
    style={({ pressed }) => [styles.key, { flex: keyDefinition.flex ?? 1 }, active && styles.keyActive, locked && styles.keyLocked, pressed && styles.keyPressed, disabled && styles.disabled]}
  >
    <Text numberOfLines={1} style={[styles.keyLabel, active && styles.keyLabelActive]}>{keyDefinition.label}</Text>
    {locked ? <View style={styles.lockDot} /> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  dock: { backgroundColor: 'rgba(20,21,25,0.98)', borderTopColor: 'rgba(255,255,255,0.12)', borderTopWidth: StyleSheet.hairlineWidth },
  bar: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 44, paddingHorizontal: 6, paddingVertical: 4 },
  modeSwitch: { backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 10, flex: 1, flexDirection: 'row', gap: 2, padding: 2 },
  modeButton: { alignItems: 'center', borderRadius: 8, flex: 1, flexDirection: 'row', gap: 5, justifyContent: 'center', minHeight: 32, paddingHorizontal: 6 },
  modeButtonActive: { backgroundColor: 'rgba(91,161,255,0.18)' },
  modeLabel: { color: KEY_MUTED, fontSize: 12, fontWeight: '500', lineHeight: 16 },
  modeLabelActive: { color: ACCENT },
  collapseButton: { alignItems: 'center', borderRadius: 10, height: 36, justifyContent: 'center', width: 40 },
  pages: { flexDirection: 'row', gap: 4, paddingBottom: 4, paddingHorizontal: 6 },
  pageButton: { alignItems: 'center', borderRadius: 7, flex: 1, justifyContent: 'center', minHeight: 30 },
  pageButtonActive: { backgroundColor: 'rgba(255,255,255,0.1)' },
  pageLabel: { color: KEY_MUTED, fontSize: 12, fontWeight: '500', lineHeight: 16 },
  pageLabelActive: { color: KEY_LABEL },
  modifierRow: { flexDirection: 'row', gap: 3, paddingBottom: 3, paddingHorizontal: 6 },
  keys: { gap: 3, paddingBottom: 3, paddingHorizontal: 6 },
  keyRow: { flexDirection: 'row', gap: 3 },
  key: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.09)', borderColor: 'rgba(255,255,255,0.08)', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, height: 38, justifyContent: 'center', minWidth: 0, paddingHorizontal: 2 },
  keyActive: { backgroundColor: 'rgba(91,161,255,0.24)', borderColor: 'rgba(159,210,255,0.36)' },
  keyLocked: { borderColor: ACCENT },
  keyPressed: { backgroundColor: 'rgba(255,255,255,0.2)' },
  keyLabel: { color: KEY_LABEL, fontSize: 12, fontWeight: '400', lineHeight: 16, textAlign: 'center' },
  keyLabelActive: { color: ACCENT },
  lockDot: { backgroundColor: ACCENT, borderRadius: 2, height: 4, position: 'absolute', right: 5, top: 5, width: 4 },
  disabled: { opacity: 0.34 },
  pressed: { opacity: 0.58 },
});
