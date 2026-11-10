import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { remoteDesktopErrorMessage } from './errors';
import { RemoteDesktopSettingsMenu, transportIcon, transportLabel } from './RemoteDesktopSettingsMenu';
import { RemoteDesktopToolbar } from './RemoteDesktopToolbar';
import { RemoteDesktopTouchSurface } from './RemoteDesktopTouchSurface';
import { RemoteDesktopWindowPicker } from './RemoteDesktopWindowPicker';
import { useRemoteDesktop } from './use-remote-desktop';
import type { RemoteDesktopMouseMode } from './preferences';
import { remoteDesktopTextToSend } from './text-input';

export function RemoteDesktopScreen({ instanceId }: { instanceId: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const remote = useRemoteDesktop(instanceId);
  const [windowPicker, setWindowPicker] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const keyboardInput = useRef<TextInput>(null);
  const pendingRemoteText = useRef('');
  const { snapshot } = remote;
  const capability = remote.capability;

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const hideKeyboard = useCallback(() => {
    Keyboard.dismiss();
    setKeyboardVisible(false);
  }, []);
  const dismissKeyboard = useCallback(() => { Keyboard.dismiss(); }, []);

  useEffect(() => {
    if (!snapshot.inputEnabled) dismissKeyboard();
  }, [dismissKeyboard, snapshot.inputEnabled]);

  useEffect(() => {
    if (keyboardVisible) keyboardInput.current?.focus();
    else keyboardInput.current?.blur();
  }, [keyboardVisible]);

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

  return <View style={[styles.root, { backgroundColor: '#000' }]}>
    <StatusBar style="light" />
    <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
      <Pressable accessibilityLabel={t('common.back')} accessibilityRole="button" hitSlop={10} onPress={back} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
        <Icon color="#fff" name="chevron-back" size={25} />
      </Pressable>
      <View style={styles.headerCopy}>
        <Text numberOfLines={1} style={styles.headerTitle}>{remote.instance?.name || t('remoteDesktop.title')}</Text>
        <View style={styles.statusRow}>
          {snapshot.phase === 'connecting' || snapshot.phase === 'reconnecting' ? <ActivityIndicator color="#9fd2ff" size="small" /> : <View style={[styles.statusDot, { backgroundColor: snapshot.phase === 'error' || snapshot.phase === 'stopped' ? '#ff6961' : '#34c759' }]} />}
          <Text numberOfLines={1} style={styles.headerStatus}>{phaseLabel}</Text>
          {snapshot.viewerCount > 1 ? <Text numberOfLines={1} style={styles.headerMeta}>· {t('remoteDesktop.viewers', { count: snapshot.viewerCount })}</Text> : null}
        </View>
      </View>
      {activeTransport ? <View accessibilityLabel={`${transportLabel(activeTransport, t)}: ${t('remoteDesktop.transportActive')}`} accessibilityRole="image" style={styles.transportBadge}>
        <Icon color="#9fd2ff" name={transportIcon(activeTransport)} size={18} />
      </View> : null}
      <RemoteDesktopSettingsMenu
        onChooseTarget={() => setWindowPicker(true)}
        onDisconnect={disconnect}
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

    <View style={styles.stage}>
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
    </View>

    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      blurOnSubmit={false}
      importantForAccessibility="no"
      keyboardAppearance="dark"
      onChangeText={(value) => {
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
      onBlur={() => { pendingRemoteText.current = ''; }}
      onKeyPress={(event) => {
        const code = remoteKeyboardCode(event.nativeEvent.key);
        if (!code || !snapshot.inputEnabled) return;
        remote.controller?.sendKey(code, true);
        remote.controller?.sendKey(code, false);
      }}
      onSubmitEditing={() => {
        if (!snapshot.inputEnabled) return;
        remote.controller?.sendKey('Enter', true);
        remote.controller?.sendKey('Enter', false);
      }}
      ref={keyboardInput}
      returnKeyType="done"
      showSoftInputOnFocus
      style={styles.hiddenInput}
      value=""
    />

    {showVideo && snapshot.phase !== 'error' && snapshot.phase !== 'stopped' ? <RemoteDesktopToolbar
      bottomInset={insets.bottom}
      keyboardVisible={keyboardVisible}
      mouseMode={remote.preferences.mouseMode}
      onInput={() => {
        if (snapshot.inputEnabled) {
          hideKeyboard();
          remote.controller?.disableInput();
        } else remote.controller?.enableInput();
      }}
      onKeyboard={() => {
        if (keyboardVisible) hideKeyboard();
        else setKeyboardVisible(true);
      }}
      onMouseMode={(value: RemoteDesktopMouseMode) => remote.setMouseMode(value)}
      snapshot={snapshot}
    /> : null}

    <RemoteDesktopWindowPicker
      capability={capability}
      loadWindows={remote.loadWindows}
      onClose={() => setWindowPicker(false)}
      onSelect={remote.setTarget}
      target={snapshot.target}
      visible={windowPicker}
    />
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
  headerCopy: { flex: 1, gap: 1, minWidth: 0 },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '500', lineHeight: 19 },
  statusRow: { alignItems: 'center', flexDirection: 'row', gap: 5, minHeight: 16 },
  statusDot: { borderRadius: 4, height: 7, width: 7 },
  headerStatus: { color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 16 },
  headerMeta: { color: 'rgba(255,255,255,0.5)', fontSize: 12, lineHeight: 16 },
  transportBadge: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 12, height: 32, justifyContent: 'center', width: 36 },
  stage: { flex: 1, position: 'relative' },
  centered: { alignItems: 'center', flex: 1, gap: 10, justifyContent: 'center', padding: 30 },
  centeredTitle: { color: '#fff', fontSize: 17, fontWeight: '500', lineHeight: 23, textAlign: 'center' },
  centeredDetail: { color: 'rgba(255,255,255,0.64)', fontSize: 13, lineHeight: 19, maxWidth: 360, textAlign: 'center' },
  centeredAction: { backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 10, marginTop: 4, paddingHorizontal: 18, paddingVertical: 9 },
  centeredActionText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  errorBanner: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, bottom: 72, flexDirection: 'row', gap: 9, left: 12, paddingHorizontal: 12, paddingVertical: 9, position: 'absolute', right: 12 },
  errorText: { flex: 1, fontSize: 12, lineHeight: 17 },
  bannerAction: { fontSize: 13, fontWeight: '500' },
  waiting: { alignItems: 'center', alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, flexDirection: 'row', gap: 8, paddingHorizontal: 13, paddingVertical: 9, position: 'absolute', top: '45%' },
  waitingText: { color: '#fff', fontSize: 13, lineHeight: 18 },
  hiddenInput: { height: 1, opacity: 0.01, position: 'absolute', width: 1 },
  pressed: { opacity: 0.58 },
});
