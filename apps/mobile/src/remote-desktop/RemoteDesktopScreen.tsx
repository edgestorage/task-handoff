import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  startRemoteDesktopTextInputObservation,
  stopRemoteDesktopTextInputObservation,
  subscribeRemoteDesktopTextInput,
} from '../../modules/task-handoff-remote-desktop/src';
import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { subscribeToKeyboardState, type MobileKeyboardState } from '../platform/keyboard';
import { remoteDesktopErrorMessage } from './errors';
import { RemoteDesktopConnectionInfo } from './RemoteDesktopConnectionInfo';
import { RemoteDesktopSettingsMenu } from './RemoteDesktopSettingsMenu';
import { RemoteDesktopToolbar } from './RemoteDesktopToolbar';
import { RemoteDesktopTouchSurface } from './RemoteDesktopTouchSurface';
import { RemoteDesktopSourcePicker } from './RemoteDesktopSourcePicker';
import { sourceTargetLabel } from './source-label';
import { transportIcon, transportLabel } from './transport-presentation';
import { useRemoteDesktop } from './use-remote-desktop';
import type { RemoteDesktopMouseMode } from './preferences';
import { remoteDesktopTextInputUpdate, remoteDesktopTextToSend } from './text-input';

const KEYBOARD_INPUT_ID = 'remote-desktop-keyboard-input';
const KEYBOARD_ACCESSORY_HEIGHT = 44;
const TOOLBAR_ACCENT = '#9fd2ff';
const INITIAL_KEYBOARD_STATE: MobileKeyboardState = { visible: false, height: 0, duration: 250, easing: 'keyboard' };

function keyboardAnimationEasing(easing: MobileKeyboardState['easing']) {
  switch (easing) {
    case 'linear': return Easing.linear;
    case 'easeIn': return Easing.in(Easing.ease);
    case 'easeOut': return Easing.out(Easing.ease);
    case 'easeInEaseOut': return Easing.inOut(Easing.ease);
    default: return Easing.bezier(0.17, 0.59, 0.4, 0.99);
  }
}

export function RemoteDesktopScreen({ instanceId }: { instanceId: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const remote = useRemoteDesktop(instanceId);
  const [sourcePicker, setSourcePicker] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState(false);
  const [keyboard, setKeyboard] = useState<MobileKeyboardState>(INITIAL_KEYBOARD_STATE);
  const keyboardVisible = keyboard.visible;
  const softwareKeyboardVisible = keyboard.visible && keyboard.height > 0;
  const [keyboardInset] = useState(() => new Animated.Value(0));
  const keyboardInput = useRef<TextInput>(null);
  const pendingRemoteText = useRef('');
  const nativeTextInputActive = useRef(false);
  const composingText = useRef(false);
  const { snapshot } = remote;
  const snapshotRef = useRef(snapshot);
  const controllerRef = useRef(remote.controller);
  const capability = remote.capability;

  useEffect(() => {
    snapshotRef.current = snapshot;
    controllerRef.current = remote.controller;
  }, [remote.controller, snapshot]);
  useEffect(() => subscribeToKeyboardState(setKeyboard), []);
  useEffect(() => {
    const target = Platform.OS === 'ios' && softwareKeyboardVisible ? keyboard.height + KEYBOARD_ACCESSORY_HEIGHT : 0;
    Animated.timing(keyboardInset, {
      duration: keyboard.duration,
      easing: keyboardAnimationEasing(keyboard.easing),
      toValue: target,
      useNativeDriver: false,
    }).start();
  }, [keyboard.duration, keyboard.easing, keyboard.height, keyboardInset, softwareKeyboardVisible]);
  useEffect(() => {
    const subscription = subscribeRemoteDesktopTextInput(({ composing, text }) => {
      composingText.current = composing;
      if (composing || !nativeTextInputActive.current) return;
      const update = remoteDesktopTextInputUpdate(pendingRemoteText.current, text, false);
      pendingRemoteText.current = update.nextText;
      if (update.textToSend && snapshotRef.current.inputEnabled) controllerRef.current?.sendText(update.textToSend);
    });
    return () => {
      subscription?.remove();
      stopRemoteDesktopTextInputObservation();
      nativeTextInputActive.current = false;
    };
  }, []);

  const resetTextInput = useCallback(() => {
    stopRemoteDesktopTextInputObservation();
    nativeTextInputActive.current = false;
    composingText.current = false;
    pendingRemoteText.current = '';
    keyboardInput.current?.clear();
  }, []);

  const hideKeyboard = useCallback(() => {
    resetTextInput();
    keyboardInput.current?.blur();
    Keyboard.dismiss();
    setKeyboard((current) => ({ ...current, visible: false, height: 0 }));
  }, [resetTextInput]);
  const showKeyboard = useCallback(() => { keyboardInput.current?.focus(); }, []);

  useEffect(() => {
    if (snapshot.inputEnabled) return;
    resetTextInput();
    keyboardInput.current?.blur();
    Keyboard.dismiss();
  }, [resetTextInput, snapshot.inputEnabled]);

  useEffect(() => {
    if (!snapshot.inputEnabled || !keyboardVisible) pendingRemoteText.current = '';
  }, [keyboardVisible, snapshot.inputEnabled]);

  const disconnect = () => {
    Alert.alert(t('remoteDesktop.closeTitle'), t('remoteDesktop.closeDescription'), [
      { text: t('remoteDesktop.cancel'), style: 'cancel' },
      { text: t('remoteDesktop.disconnect'), style: 'destructive', onPress: () => {
        hideKeyboard();
        void remote.disconnect();
      } },
    ]);
  };

  const back = () => {
    hideKeyboard();
    router.back();
  };

  const phaseLabel = snapshot.phase === 'error'
    ? t('remoteDesktop.error')
    : snapshot.phase === 'stopped'
      ? t('remoteDesktop.stopped')
      : snapshot.phase === 'connecting'
        ? t('remoteDesktop.connecting')
        : snapshot.phase === 'reconnecting' || snapshot.transportStates.websocket === 'pending'
          ? t('remoteDesktop.reconnecting')
          : snapshot.paused
            ? t('remoteDesktop.paused')
            : t('remoteDesktop.connected');
  const activeTransport = snapshot.path ?? (Object.entries(snapshot.transportStates).find(([, state]) => state === 'active')?.[0] as keyof typeof snapshot.transportStates | undefined);
  const showVideo = snapshot.phase === 'connected' || snapshot.phase === 'paused' || snapshot.phase === 'reconnecting' || Boolean(snapshot.path);
  const errorMessage = remoteDesktopErrorMessage(snapshot.error, t);
  const sourceTitle = sourceTargetLabel(snapshot.target, t);

  return <View style={[styles.root, { backgroundColor: '#000' }]}>
    <StatusBar style="light" />
    <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
      <Pressable accessibilityLabel={t('common.back')} accessibilityRole="button" hitSlop={10} onPress={back} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
        <Icon color="#fff" name="chevron-back" size={25} />
      </Pressable>
      <Pressable
        accessibilityHint={t('remoteDesktop.sourcePickerHint')}
        accessibilityLabel={`${t('remoteDesktop.chooseSource')}: ${sourceTitle}`}
        accessibilityRole="button"
        onPress={() => setSourcePicker(true)}
        style={({ pressed }) => [styles.headerCopy, pressed && styles.headerSourcePressed]}
      >
        <View style={styles.sourceRow}>
          <Text numberOfLines={1} style={styles.headerTitle}>{sourceTitle}</Text>
          <Icon color="rgba(255,255,255,0.64)" name="chevron-down" size={14} />
        </View>
        <View style={styles.statusRow}>
          {snapshot.phase === 'connecting' || snapshot.phase === 'reconnecting' ? <ActivityIndicator color="#9fd2ff" size="small" /> : <View style={[styles.statusDot, { backgroundColor: snapshot.phase === 'error' || snapshot.phase === 'stopped' ? '#ff6961' : '#34c759' }]} />}
          <Text numberOfLines={1} style={styles.headerStatus}>{phaseLabel}</Text>
          {snapshot.viewerCount > 0 ? <Text numberOfLines={1} style={styles.headerMeta}>· {t('remoteDesktop.viewers', { count: snapshot.viewerCount })}</Text> : null}
        </View>
      </Pressable>
      {activeTransport ? (() => {
        const TransportIcon = transportIcon(activeTransport);
        return <Pressable
          accessibilityHint={t('remoteDesktop.connectionInfoHint')}
          accessibilityLabel={`${transportLabel(activeTransport, t)}: ${t('remoteDesktop.transportActive')}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => setConnectionInfo(true)}
          style={({ pressed }) => [styles.transportBadge, pressed && styles.transportBadgePressed]}
        >
          <TransportIcon color="#9fd2ff" size={20} strokeWidth={1.9} />
        </Pressable>;
      })() : null}
      <RemoteDesktopSettingsMenu
        onDisconnect={disconnect}
        onSetInputEnabled={remote.setInputEnabled}
        onSetFrameRate={remote.setFrameRate}
        onSetResolution={remote.setResolution}
        onToggleTransport={remote.toggleTransport}
        snapshot={snapshot}
      >
        <Pressable accessibilityLabel={t('remoteDesktop.settings')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
          <Icon color="#fff" name="ellipsis-horizontal" size={23} />
        </Pressable>
      </RemoteDesktopSettingsMenu>
    </View>

    <Animated.View style={[styles.stage, Platform.OS === 'ios' ? { marginBottom: keyboardInset } : undefined]}>
      {capability?.available === false || (!capability && remote.instance) ? <CenteredState title={t('remoteDesktop.unsupported')} detail={capability?.reason === 'REMOTE_DESKTOP_UPDATING' ? t('remoteDesktop.loading') : t('remoteDesktop.unsupportedDescription')} />
        : !remote.ready || !remote.instance ? <CenteredState loading title={t('remoteDesktop.connecting')} detail={t('remoteDesktop.loading')} />
          : showVideo ? <RemoteDesktopTouchSurface controller={remote.controller} mouseMode={remote.preferences.mouseMode} snapshot={snapshot} />
            : snapshot.phase === 'error' || snapshot.phase === 'stopped' ? <CenteredState title={snapshot.phase === 'stopped' ? t('remoteDesktop.stopped') : t('remoteDesktop.error')} detail={snapshot.phase === 'error' ? errorMessage || t('remoteDesktop.errorGeneric') : undefined} actionLabel={t('remoteDesktop.reconnect')} onAction={() => { void remote.reconnect(); }} />
              : <CenteredState loading title={t('remoteDesktop.connecting')} detail={t('remoteDesktop.waitingForFrame')} />}
      {showVideo && snapshot.phase === 'error' ? <View style={[styles.errorBanner, { backgroundColor: colors.errorSoft, borderColor: colors.error }]}>
        <Icon color={colors.error} name="alert-circle-outline" size={18} />
        <Text numberOfLines={3} style={[styles.errorText, { color: colors.error }]}>{errorMessage}</Text>
        <Pressable accessibilityRole="button" onPress={() => { void remote.reconnect(); }}><Text style={[styles.bannerAction, { color: colors.error }]}>{t('remoteDesktop.retry')}</Text></Pressable>
      </View> : null}
      {showVideo && !snapshot.streamURL && snapshot.path !== 'websocket' && !snapshot.path ? <View pointerEvents="none" style={styles.waiting}><ActivityIndicator color="#fff" size="small" /><Text style={styles.waitingText}>{t('remoteDesktop.waitingForFrame')}</Text></View> : null}
    </Animated.View>

    <TextInput
      autoCapitalize="none"
      autoComplete="off"
      autoCorrect={false}
      blurOnSubmit={false}
      importantForAccessibility="no"
      keyboardAppearance="dark"
      nativeID={KEYBOARD_INPUT_ID}
      onChangeText={(value) => {
        if (nativeTextInputActive.current) return;
        if (!snapshot.inputEnabled) {
          pendingRemoteText.current = '';
          return;
        }
        if (!value) {
          pendingRemoteText.current = '';
          return;
        }
        const previous = pendingRemoteText.current;
        const text = remoteDesktopTextToSend(previous, value);
        if (text) remote.controller?.sendText(text);
        pendingRemoteText.current = value;
      }}
      onBlur={resetTextInput}
      onFocus={() => {
        nativeTextInputActive.current = startRemoteDesktopTextInputObservation(KEYBOARD_INPUT_ID);
        composingText.current = false;
        pendingRemoteText.current = '';
      }}
      onKeyPress={(event) => {
        if (composingText.current) return;
        const code = remoteKeyboardCode(event.nativeEvent.key);
        if (!code || !snapshot.inputEnabled) return;
        remote.controller?.sendKey(code, true);
        remote.controller?.sendKey(code, false);
      }}
      onSubmitEditing={() => {
        if (!snapshot.inputEnabled || composingText.current) return;
        remote.controller?.sendKey('Enter', true);
        remote.controller?.sendKey('Enter', false);
        // The software keyboard's Done key dismisses the keyboard; hardware
        // Enter keeps focus so continuous typing is not interrupted.
        if (softwareKeyboardVisible) hideKeyboard();
      }}
      ref={keyboardInput}
      returnKeyType="done"
      showSoftInputOnFocus
      style={styles.hiddenInput}
      spellCheck={false}
      testID={KEYBOARD_INPUT_ID}
    />

    {Platform.OS === 'ios' && softwareKeyboardVisible ? <Animated.View style={[styles.keyboardAccessory, { bottom: Animated.subtract(keyboardInset, KEYBOARD_ACCESSORY_HEIGHT) }]}>
        <Pressable accessibilityLabel={t('remoteDesktop.hideKeyboard')} accessibilityRole="button" hitSlop={6} onPress={hideKeyboard} style={({ pressed }) => [styles.keyboardAccessoryButton, pressed && styles.pressed]}>
          <Icon color={TOOLBAR_ACCENT} name="chevron-down" size={16} />
          <Text style={styles.keyboardAccessoryText}>{t('remoteDesktop.hideKeyboard')}</Text>
        </Pressable>
    </Animated.View> : null}

    {showVideo && snapshot.phase !== 'error' && snapshot.phase !== 'stopped' ? <RemoteDesktopToolbar
      bottomInset={insets.bottom}
      keyboardVisible={keyboardVisible}
      mouseMode={remote.preferences.mouseMode}
      obscured={Platform.OS === 'ios' && softwareKeyboardVisible}
      onInput={() => {
        if (!snapshot.isController) remote.controller?.requestControl();
        else if (!snapshot.inputEnabled) remote.controller?.enableInput();
      }}
      onKeyboard={() => {
        if (keyboardVisible) hideKeyboard();
        else showKeyboard();
      }}
      onMouseMode={(value: RemoteDesktopMouseMode) => remote.setMouseMode(value)}
      snapshot={snapshot}
    /> : null}

    <RemoteDesktopSourcePicker
      capability={capability}
      loadSources={remote.loadSources}
      onClose={() => setSourcePicker(false)}
      onSelect={remote.setTarget}
      target={snapshot.target}
      visible={sourcePicker}
    />
    <RemoteDesktopConnectionInfo onClose={() => setConnectionInfo(false)} snapshot={snapshot} visible={connectionInfo} />
  </View>;
}

function CenteredState({ actionLabel, detail, loading = false, onAction, title }: { actionLabel?: string; detail?: string; loading?: boolean; onAction?(): void; title: string }) {
  return <View style={styles.centered}>
    {loading ? <ActivityIndicator color="#fff" size="large" /> : <Icon color="rgba(255,255,255,0.72)" name="desktop-outline" size={34} />}
    <Text style={styles.centeredTitle}>{title}</Text>
    {detail ? <Text style={styles.centeredDetail}>{detail}</Text> : null}
    {actionLabel && onAction ? <Pressable accessibilityRole="button" onPress={onAction} style={({ pressed }) => [styles.centeredAction, pressed && styles.pressed]}><Text style={styles.centeredActionText}>{actionLabel}</Text></Pressable> : null}
  </View>;
}

function remoteKeyboardCode(key: string) {
  // Enter is committed by onSubmitEditing so hardware and soft return keys
  // cannot send the same key press twice.
  if (key === 'Backspace' || key === 'Delete' || key === 'Escape' || key === 'Tab' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown') return key;
  return undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { alignItems: 'center', backgroundColor: 'rgba(15, 16, 18, 0.94)', flexDirection: 'row', gap: 3, minHeight: 56, paddingBottom: 6, paddingHorizontal: 6 },
  headerButton: { alignItems: 'center', height: 42, justifyContent: 'center', width: 40 },
  headerCopy: { flex: 1, gap: 1, justifyContent: 'center', minHeight: 42, minWidth: 0 },
  headerSourcePressed: { opacity: 0.58 },
  sourceRow: { alignItems: 'center', flexDirection: 'row', gap: 4, minWidth: 0, overflow: 'hidden' },
  headerTitle: { color: '#fff', flexShrink: 1, fontSize: 15, fontWeight: '500', lineHeight: 19, minWidth: 0 },
  statusRow: { alignItems: 'center', flexDirection: 'row', gap: 5, minHeight: 16 },
  statusDot: { borderRadius: 4, height: 7, width: 7 },
  headerStatus: { color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 16 },
  headerMeta: { color: 'rgba(255,255,255,0.5)', fontSize: 12, lineHeight: 16 },
  transportBadge: { alignItems: 'center', borderRadius: 20, height: 40, justifyContent: 'center', marginLeft: 5, width: 40 },
  transportBadgePressed: { backgroundColor: 'rgba(255,255,255,0.12)' },
  stage: { flex: 1, position: 'relative' },
  centered: { alignItems: 'center', flex: 1, gap: 10, justifyContent: 'center', padding: 30 },
  centeredTitle: { color: '#fff', fontSize: 17, fontWeight: '500', lineHeight: 23, textAlign: 'center' },
  centeredDetail: { color: 'rgba(255,255,255,0.64)', fontSize: 13, lineHeight: 19, maxWidth: 360, textAlign: 'center' },
  centeredAction: { backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 10, marginTop: 4, paddingHorizontal: 18, paddingVertical: 9 },
  centeredActionText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  errorBanner: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, bottom: 72, flexDirection: 'row', gap: 9, left: 12, paddingHorizontal: 12, paddingVertical: 9, position: 'absolute', right: 12 },
  errorText: { flex: 1, fontSize: 12, lineHeight: 17 },
  bannerAction: { fontSize: 13, fontWeight: '500' },
  keyboardAccessory: { alignItems: 'center', backgroundColor: 'rgba(20,21,25,0.97)', borderTopColor: 'rgba(255,255,255,0.12)', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'flex-end', left: 0, minHeight: KEYBOARD_ACCESSORY_HEIGHT, paddingHorizontal: 12, position: 'absolute', right: 0, zIndex: 4 },
  keyboardAccessoryButton: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 6, minHeight: 36, paddingHorizontal: 10 },
  keyboardAccessoryText: { color: TOOLBAR_ACCENT, fontSize: 14, fontWeight: '500' },
  waiting: { alignItems: 'center', alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, flexDirection: 'row', gap: 8, paddingHorizontal: 13, paddingVertical: 9, position: 'absolute', top: '45%' },
  waitingText: { color: '#fff', fontSize: 13, lineHeight: 18 },
  hiddenInput: { height: 1, opacity: 0.01, position: 'absolute', width: 1 },
  pressed: { opacity: 0.58 },
});
