import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, DeviceEventEmitter, Dimensions, Easing, Keyboard, type LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { remoteDesktopSupportsCapturePrecision, type DesktopSource } from '@task-handoff/protocol/remote-desktop';
import {
  currentRemoteDesktopLandscapeSide,
  startRemoteDesktopTextInputObservation,
  stopRemoteDesktopTextInputObservation,
  subscribeRemoteDesktopOrientation,
  subscribeRemoteDesktopTextInput,
} from '../../modules/task-handoff-remote-desktop/src';
import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { diagnosticLog } from '../observability/diagnostic-logs';
import { subscribeToKeyboardState, type MobileKeyboardState } from '../platform/keyboard';
import { isRemoteDesktopSourceEndedError, remoteDesktopErrorMessage } from './errors';
import {
  DEFAULT_REMOTE_DESKTOP_KEYBOARD_DURATION_MS,
  REMOTE_DESKTOP_KEYBOARD_BAR_HEIGHT,
  remoteDesktopKeyboardObstruction,
  remoteDesktopNativeKeyboardReplacesVirtualSurface,
} from './keyboard-layout';
import { RemoteDesktopConnectionInfo } from './RemoteDesktopConnectionInfo';
import { RemoteDesktopKeyboardBar, RemoteDesktopVirtualKeyboard } from './RemoteDesktopVirtualKeyboard';
import { RemoteDesktopSettingsMenu } from './RemoteDesktopSettingsMenu';
import { RemoteDesktopToolbar } from './RemoteDesktopToolbar';
import { RemoteDesktopTouchSurface } from './RemoteDesktopTouchSurface';
import { RemoteDesktopSourcePicker } from './RemoteDesktopSourcePicker';
import { remoteDesktopSourceHeaderLabel } from './source-label';
import { transportIcon, transportLabel } from './transport-presentation';
import { useRemoteDesktop } from './use-remote-desktop';
import type { RemoteDesktopMouseMode } from './preferences';
import { remoteDesktopTextInputUpdate, type RemoteDesktopTextEdit } from './text-input';
import type { RemoteDesktopKeyboardMode } from './virtual-keyboard';
import { rememberSessionRemoteDesktopLink, removeSessionRemoteDesktopLink } from './session-links';

const KEYBOARD_INPUT_ID = 'remote-desktop-keyboard-input';
const KEY_DELETION_HANDLED_WINDOW_MS = 250;
const LANDSCAPE_RAIL_WIDTH = 52;
const INITIAL_KEYBOARD_STATE: MobileKeyboardState = { visible: false, height: 0, duration: DEFAULT_REMOTE_DESKTOP_KEYBOARD_DURATION_MS, easing: 'keyboard' };

function keyboardAnimationEasing(easing: MobileKeyboardState['easing']) {
  switch (easing) {
    case 'linear': return Easing.linear;
    case 'easeIn': return Easing.in(Easing.ease);
    case 'easeOut': return Easing.out(Easing.ease);
    case 'easeInEaseOut': return Easing.inOut(Easing.ease);
    default: return Easing.bezier(0.17, 0.59, 0.4, 0.99);
  }
}

export function RemoteDesktopScreen({ instanceId, sessionId }: { instanceId: string; sessionId?: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const landscape = viewport.width > viewport.height;
  const [landscapeSide, setLandscapeSide] = useState<'left' | 'right'>(() => currentRemoteDesktopLandscapeSide() ?? (insets.left > insets.right ? 'left' : 'right'));
  const remote = useRemoteDesktop(instanceId, { sessionId });
  const [sourcePicker, setSourcePicker] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState(false);
  const [connectionSources, setConnectionSources] = useState<DesktopSource[]>([]);
  const [keyboard, setKeyboard] = useState<MobileKeyboardState>(INITIAL_KEYBOARD_STATE);
  const [keyboardMode, setKeyboardMode] = useState<RemoteDesktopKeyboardMode>('system');
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [virtualKeyboardHeight, setVirtualKeyboardHeight] = useState(0);
  const [virtualKeyboardSurfaceVisible, setVirtualKeyboardSurfaceVisible] = useState(false);
  const softwareKeyboardVisible = keyboard.visible && keyboard.height > 0;
  const systemKeyboardVisible = keyboardOpen && keyboardMode === 'system' && softwareKeyboardVisible;
  const virtualKeyboardInteractive = keyboardOpen && keyboardMode === 'virtual';
  const keyboardVisible = keyboardOpen && (systemKeyboardVisible || virtualKeyboardSurfaceVisible);
  const [keyboardInset] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const nativeSubscription = subscribeRemoteDesktopOrientation(setLandscapeSide);
    const dimensionsSubscription = Dimensions.addEventListener('change', ({ window }) => {
      if (window.width <= window.height) return;
      const nativeSide = currentRemoteDesktopLandscapeSide();
      if (nativeSide) setLandscapeSide(nativeSide);
    });
    const subscription = DeviceEventEmitter.addListener('namedOrientationDidChange', (event: { name?: string }) => {
      if (event.name === 'landscape-primary') setLandscapeSide('right');
      else if (event.name === 'landscape-secondary') setLandscapeSide('left');
    });
    return () => {
      nativeSubscription?.remove();
      dimensionsSubscription.remove();
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    diagnosticLog.info('remote.desktop.viewport', {
      height: Math.round(viewport.height),
      insetBottom: insets.bottom,
      insetLeft: insets.left,
      insetRight: insets.right,
      insetTop: insets.top,
      landscapeSide,
      width: Math.round(viewport.width),
    });
  }, [insets.bottom, insets.left, insets.right, insets.top, landscapeSide, viewport.height, viewport.width]);
  // The previous fit-to-reduced-height layout kept the content centered in the
  // visible area, which moved its visual center by half the obstruction. Match
  // that position without shrinking the capture surface.
  const keyboardStageOffset = useMemo(() => Animated.multiply(keyboardInset, -0.5), [keyboardInset]);
  const [virtualKeyboardOpacity] = useState(() => new Animated.Value(0));
  const keyboardAnimationGeneration = useRef(0);
  const keyboardModeRef = useRef<RemoteDesktopKeyboardMode>('system');
  const keyboardInput = useRef<TextInput>(null);
  const pendingRemoteText = useRef('');
  const keyDeletionAt = useRef(0);
  const nativeTextInputActive = useRef(false);
  const composingText = useRef(false);
  const { snapshot } = remote;
  const snapshotRef = useRef(snapshot);
  const controllerRef = useRef(remote.controller);
  const capability = remote.capability;
  const rememberedTargetKey = useRef<string | undefined>(undefined);
  const stoppedSessionLink = useRef(false);

  useEffect(() => {
    // A restored target is only a hint until the component accepts it. Do not
    // turn the instance fallback (or a failed reconnect attempt) into a
    // session-owned link before a real desktop session exists.
    if (!sessionId || !remote.ready || !remote.snapshot.session || stoppedSessionLink.current) return;
    const targetKey = JSON.stringify(remote.snapshot.target);
    if (rememberedTargetKey.current === targetKey) return;
    rememberedTargetKey.current = targetKey;
    rememberSessionRemoteDesktopLink({
      controlPlaneId: remote.controlPlaneId,
      instanceId,
      sessionId,
      target: remote.snapshot.target,
    });
  }, [instanceId, remote.controlPlaneId, remote.ready, remote.snapshot.session, remote.snapshot.target, sessionId]);

  useEffect(() => {
    if (!connectionInfo || !remote.capability?.sourceProviders.some((provider) => provider.available)) return;
    const controller = new AbortController();
    void remote.loadSources(controller.signal)
      .then((items) => { if (!controller.signal.aborted) setConnectionSources(items); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [connectionInfo, remote.capability, remote.loadSources]);

  useEffect(() => {
    snapshotRef.current = snapshot;
    controllerRef.current = remote.controller;
  }, [remote.controller, snapshot]);
  useEffect(() => subscribeToKeyboardState((state) => {
    setKeyboard(state);
    if (remoteDesktopNativeKeyboardReplacesVirtualSurface(keyboardModeRef.current, state.height, state.visible)) {
      setVirtualKeyboardSurfaceVisible(false);
    }
  }), []);

  const keyboardObstructionTarget = remoteDesktopKeyboardObstruction({
    mode: keyboardMode,
    nativeKeyboardHeight: keyboard.height,
    open: keyboardOpen,
    virtualKeyboardHeight,
    virtualKeyboardSurfaceVisible,
  });

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const generation = keyboardAnimationGeneration.current + 1;
    keyboardAnimationGeneration.current = generation;
    Animated.timing(keyboardInset, {
      duration: keyboard.duration,
      easing: keyboardAnimationEasing(keyboard.easing),
      toValue: keyboardObstructionTarget,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (!finished || keyboardAnimationGeneration.current !== generation) return;
      if (!keyboardOpen) setVirtualKeyboardSurfaceVisible(false);
    });
  }, [keyboard.duration, keyboard.easing, keyboardInset, keyboardObstructionTarget, keyboardOpen]);

  useEffect(() => {
    Animated.timing(virtualKeyboardOpacity, {
      duration: Math.min(keyboard.duration, 180),
      easing: keyboardAnimationEasing(keyboard.easing),
      toValue: virtualKeyboardSurfaceVisible ? 1 : 0,
      useNativeDriver: false,
    }).start();
  }, [keyboard.duration, keyboard.easing, virtualKeyboardOpacity, virtualKeyboardSurfaceVisible]);

  const sendTextEdit = useCallback((edit: RemoteDesktopTextEdit) => {
    const controller = controllerRef.current;
    if (!controller) return;
    for (let index = 0; index < edit.deleteCount; index += 1) {
      controller.sendKey('Backspace', true);
      controller.sendKey('Backspace', false);
    }
    if (edit.insertText) controller.sendText(edit.insertText);
  }, []);

  const applyTextInputValue = useCallback((previousText: string, text: string) => {
    if (!snapshotRef.current.inputEnabled) {
      pendingRemoteText.current = '';
      keyDeletionAt.current = 0;
      return;
    }
    const update = remoteDesktopTextInputUpdate(previousText, text, false);
    pendingRemoteText.current = update.nextText;
    const deletionHandledByKey = keyDeletionAt.current > 0
      && Date.now() - keyDeletionAt.current <= KEY_DELETION_HANDLED_WINDOW_MS;
    keyDeletionAt.current = 0;
    if (!update.edit) return;
    if (update.edit.deleteCount > 0) {
      diagnosticLog.info('remote.desktop.text.edit', {
        deleteCount: update.edit.deleteCount,
        insertLength: update.edit.insertText.length,
        previousLength: previousText.length,
        currentLength: text.length,
        deletionHandledByKey,
      });
    }
    if (!deletionHandledByKey) sendTextEdit(update.edit);
  }, [sendTextEdit]);

  useEffect(() => {
    const subscription = subscribeRemoteDesktopTextInput(({ composing, text }) => {
      composingText.current = composing;
      if (composing || !nativeTextInputActive.current) return;
      applyTextInputValue(pendingRemoteText.current, text);
    });
    return () => {
      subscription?.remove();
      stopRemoteDesktopTextInputObservation();
      nativeTextInputActive.current = false;
    };
  }, [applyTextInputValue]);

  const resetTextInput = useCallback(() => {
    stopRemoteDesktopTextInputObservation();
    nativeTextInputActive.current = false;
    composingText.current = false;
    pendingRemoteText.current = '';
    keyDeletionAt.current = 0;
    keyboardInput.current?.clear();
  }, []);

  const hideKeyboard = useCallback(() => {
    setKeyboardOpen(false);
    resetTextInput();
    keyboardInput.current?.blur();
    Keyboard.dismiss();
  }, [resetTextInput]);
  const showKeyboard = useCallback(() => {
    setKeyboardOpen(true);
    if (keyboardMode === 'system') keyboardInput.current?.focus();
    else setVirtualKeyboardSurfaceVisible(true);
  }, [keyboardMode]);
  const switchKeyboardMode = useCallback((mode: RemoteDesktopKeyboardMode) => {
    keyboardModeRef.current = mode;
    setKeyboardMode(mode);
    setKeyboardOpen(true);
    if (mode === 'system') {
      keyboardInput.current?.focus();
      return;
    }
    setVirtualKeyboardSurfaceVisible(true);
    resetTextInput();
    keyboardInput.current?.blur();
    Keyboard.dismiss();
  }, [resetTextInput]);

  const measureVirtualKeyboard = useCallback((event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height);
    if (height <= 0) return;
    setVirtualKeyboardHeight((current) => current === height ? current : height);
  }, []);

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
        stoppedSessionLink.current = true;
        void remote.disconnect().then(() => {
          if (sessionId) removeSessionRemoteDesktopLink(remote.controlPlaneId, instanceId, sessionId);
        });
      } },
    ]);
  };

  const reconnect = () => {
    if (sessionId) stoppedSessionLink.current = false;
    void remote.reconnect();
  };

  const back = () => {
    hideKeyboard();
    router.back();
  };

  const phaseLabel = snapshot.phase === 'error'
    ? isRemoteDesktopSourceEndedError(snapshot.error?.code)
      ? t('remoteDesktop.sourceEndedStatus')
      : t('remoteDesktop.error')
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
  const sourceEnded = isRemoteDesktopSourceEndedError(snapshot.error?.code);
  const sourceTitle = remoteDesktopSourceHeaderLabel(snapshot.target, sourceEnded, t);

  const sourceStatusColor = sourceEnded ? '#ffb340' : snapshot.phase === 'error' || snapshot.phase === 'stopped' ? '#ff6961' : snapshot.phase === 'connecting' || snapshot.phase === 'reconnecting' ? '#9fd2ff' : '#34c759';

  const sourceStatusIndicator = () => snapshot.phase === 'connecting' || snapshot.phase === 'reconnecting'
    ? <ActivityIndicator color="#9fd2ff" size="small" />
    : <View style={[styles.statusDot, { backgroundColor: sourceStatusColor }]} />;

  const renderBackButton = (rail: boolean) => <Pressable
    accessibilityLabel={t('common.back')}
    accessibilityRole="button"
    hitSlop={10}
    onPress={back}
    style={({ pressed }) => [rail ? styles.landscapeRailButton : styles.headerButton, pressed && styles.pressed]}
    testID={rail ? 'remote-desktop-landscape-back' : 'remote-desktop-header-back'}
  >
    <Icon color="#fff" name="chevron-back" size={25} />
  </Pressable>;

  const renderSourceButton = (rail: boolean) => <Pressable
    accessibilityHint={t('remoteDesktop.sourcePickerHint')}
    accessibilityLabel={`${t('remoteDesktop.chooseSource')}: ${sourceTitle}`}
    accessibilityRole="button"
    onPress={() => setSourcePicker(true)}
    style={({ pressed }) => [rail ? styles.landscapeSource : styles.headerCopy, pressed && styles.headerSourcePressed]}
    testID={rail ? 'remote-desktop-landscape-source' : 'remote-desktop-header-source'}
  >
    {rail ? <>
      <View style={styles.landscapeSourceIconWrap}>
        <View style={[styles.landscapeSourceIcon, { backgroundColor: colors.primarySoft }]} testID="remote-desktop-landscape-source-icon">
          <Icon color={colors.primary} name="swap-horizontal-outline" size={21} />
        </View>
        <View style={[styles.landscapeStatusDot, { backgroundColor: sourceStatusColor }]} testID="remote-desktop-landscape-status-dot" />
      </View>
      {snapshot.viewerCount > 0 ? <View style={styles.landscapeViewers} testID="remote-desktop-landscape-viewers">
        <Icon color="rgba(255,255,255,0.58)" name="eye-outline" size={12} />
        <Text style={styles.landscapeViewerCount}>{snapshot.viewerCount}</Text>
      </View> : null}
    </> : <>
      <View style={styles.sourceRow}>
        <Text numberOfLines={1} style={styles.headerTitle}>{sourceTitle}</Text>
        <Icon color="rgba(255,255,255,0.64)" name="chevron-down" size={14} />
      </View>
      <View style={styles.statusRow}>
        {sourceStatusIndicator()}
        <Text numberOfLines={1} style={styles.headerStatus}>{phaseLabel}</Text>
        {snapshot.viewerCount > 0 ? <Text numberOfLines={1} style={styles.headerMeta}>· {t('remoteDesktop.viewers', { count: snapshot.viewerCount })}</Text> : null}
      </View>
    </>}
  </Pressable>;

  const renderTransportButton = (rail: boolean) => activeTransport ? (() => {
    const TransportIcon = transportIcon(activeTransport);
    return <Pressable
      accessibilityHint={t('remoteDesktop.connectionInfoHint')}
      accessibilityLabel={`${transportLabel(activeTransport, t)}: ${t('remoteDesktop.transportActive')}`}
      accessibilityRole="button"
      hitSlop={6}
      onPress={() => setConnectionInfo(true)}
      style={({ pressed }) => [styles.transportBadge, rail && styles.landscapeTransportButton, pressed && styles.transportBadgePressed]}
      testID={rail ? 'remote-desktop-landscape-transport' : 'remote-desktop-header-transport'}
    >
      <TransportIcon color="#9fd2ff" size={20} strokeWidth={1.9} />
    </Pressable>;
  })() : null;

  const renderSettingsButton = (rail: boolean) => <RemoteDesktopSettingsMenu
    capturePrecisionSupported={remoteDesktopSupportsCapturePrecision(capability)}
    onDisconnect={disconnect}
    onSetCapturePrecision={remote.setCapturePrecision}
    onSetInputEnabled={remote.setInputEnabled}
    onSetFrameRate={remote.setFrameRate}
    onSetResolution={remote.setResolution}
    onToggleTransport={remote.toggleTransport}
    snapshot={snapshot}
  >
    <Pressable
      accessibilityLabel={t('remoteDesktop.settings')}
      accessibilityRole="button"
      hitSlop={10}
      style={({ pressed }) => [rail ? styles.landscapeRailButton : styles.headerButton, pressed && styles.pressed]}
      testID={rail ? 'remote-desktop-landscape-settings' : 'remote-desktop-header-settings'}
    >
      <Icon color="#fff" name="ellipsis-horizontal" size={23} />
    </Pressable>
  </RemoteDesktopSettingsMenu>;

  const header = <View style={[styles.header, { paddingTop: insets.top + 4 }]} testID="remote-desktop-header">
    {renderBackButton(false)}
    {renderSourceButton(false)}
    {renderTransportButton(false)}
    {renderSettingsButton(false)}
  </View>;

  const landscapeRail = <View
    style={[styles.landscapeRail, {
      paddingBottom: insets.bottom + 8,
      paddingLeft: (landscapeSide === 'left' ? insets.left : 0) + 4,
      paddingRight: 4,
      paddingTop: insets.top + 8,
      width: LANDSCAPE_RAIL_WIDTH + (landscapeSide === 'left' ? insets.left : 0),
    }]}
    testID="remote-desktop-landscape-rail"
  >
    {renderBackButton(true)}
    {renderSourceButton(true)}
    <View style={styles.landscapeRailActions} testID="remote-desktop-landscape-actions">
      {renderTransportButton(true)}
      {renderSettingsButton(true)}
    </View>
  </View>;

  const stage = <View style={[styles.stage, styles.stageClip]} testID="remote-desktop-stage">
    {capability?.available === false || (!capability && remote.instance) ? <CenteredState title={t('remoteDesktop.unsupported')} detail={capability?.reason === 'REMOTE_DESKTOP_UPDATING' ? t('remoteDesktop.loading') : t('remoteDesktop.unsupportedDescription')} />
      : !remote.ready || !remote.instance ? <CenteredState loading title={t('remoteDesktop.connecting')} detail={t('remoteDesktop.loading')} />
        : sourceEnded ? <CenteredState title={snapshot.target.kind === 'window' ? t('remoteDesktop.windowClosed') : t('remoteDesktop.sourceEnded')} detail={errorMessage || t('remoteDesktop.sourceEndedDetail')} actionLabel={t('remoteDesktop.chooseAnotherSource')} onAction={() => setSourcePicker(true)} />
          : showVideo ? <Animated.View
            style={[styles.stageContent, { transform: [{ translateY: keyboardStageOffset }] }]}
            testID="remote-desktop-touch-surface-host"
          >
            <RemoteDesktopTouchSurface controller={remote.controller} mouseMode={remote.preferences.mouseMode} snapshot={snapshot} />
          </Animated.View>
          : snapshot.phase === 'error' || snapshot.phase === 'stopped' ? <CenteredState title={snapshot.phase === 'stopped' ? t('remoteDesktop.stopped') : t('remoteDesktop.error')} detail={snapshot.phase === 'error' ? errorMessage || t('remoteDesktop.errorGeneric') : undefined} actionLabel={t('remoteDesktop.reconnect')} onAction={reconnect} />
            : <CenteredState loading title={t('remoteDesktop.connecting')} detail={t('remoteDesktop.waitingForFrame')} />}
    {showVideo && snapshot.phase === 'error' && !sourceEnded ? <View style={[styles.errorBanner, { backgroundColor: colors.errorSoft, borderColor: colors.error }]}>
      <Icon color={colors.error} name="alert-circle-outline" size={18} />
      <Text numberOfLines={3} style={[styles.errorText, { color: colors.error }]}>{errorMessage}</Text>
      <Pressable accessibilityRole="button" onPress={reconnect}><Text style={[styles.bannerAction, { color: colors.error }]}>{t('remoteDesktop.retry')}</Text></Pressable>
    </View> : null}
    {showVideo && !snapshot.streamURL && snapshot.path !== 'websocket' && !snapshot.path ? <View pointerEvents="none" style={styles.waiting}><ActivityIndicator color="#fff" size="small" /><Text style={styles.waitingText}>{t('remoteDesktop.waitingForFrame')}</Text></View> : null}
  </View>;

  return <View style={[styles.root, { backgroundColor: '#000' }]}>
    <StatusBar hidden={landscape} style="light" />
    {landscape ? <View style={styles.landscapeShell} testID="remote-desktop-landscape-shell">
      {landscapeRail}
      {stage}
    </View> : <>
      {header}
      {stage}
    </>}

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
        applyTextInputValue(pendingRemoteText.current, value);
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
        if (code === 'Backspace' || code === 'Delete') keyDeletionAt.current = Date.now();
        remote.controller?.sendKey(code, true);
        remote.controller?.sendKey(code, false);
      }}
      onSubmitEditing={() => {
        if (!snapshot.inputEnabled || composingText.current) return;
        remote.controller?.sendKey('Enter', true);
        remote.controller?.sendKey('Enter', false);
        // The software keyboard's Done key dismisses the keyboard; hardware
        // Enter keeps focus so continuous typing is not interrupted.
        if (systemKeyboardVisible) hideKeyboard();
      }}
      ref={keyboardInput}
      returnKeyType="done"
      showSoftInputOnFocus
      style={styles.hiddenInput}
      spellCheck={false}
      testID={KEYBOARD_INPUT_ID}
    />

    {systemKeyboardVisible ? (
      Platform.OS === 'ios'
        ? <Animated.View style={[styles.keyboardDock, styles.keyboardDockAbsolute, { bottom: Animated.subtract(keyboardInset, REMOTE_DESKTOP_KEYBOARD_BAR_HEIGHT) }]}>
            <RemoteDesktopKeyboardBar mode={keyboardMode} onCollapse={hideKeyboard} onMode={switchKeyboardMode} />
          </Animated.View>
        : <View style={[styles.keyboardDock, styles.keyboardDockFlow]}>
            <RemoteDesktopKeyboardBar mode={keyboardMode} onCollapse={hideKeyboard} onMode={switchKeyboardMode} />
          </View>
    ) : null}

    {Platform.OS === 'ios' ? <Animated.View
      onLayout={measureVirtualKeyboard}
      pointerEvents={virtualKeyboardInteractive ? 'auto' : 'none'}
      style={[styles.virtualKeyboardDock, {
        opacity: virtualKeyboardOpacity,
        transform: [{ translateY: Animated.subtract(virtualKeyboardHeight, keyboardInset) }],
      }]}
    >
      <RemoteDesktopVirtualKeyboard
        bottomInset={insets.bottom}
        enabled={virtualKeyboardInteractive && snapshot.inputEnabled && snapshot.isController && !snapshot.paused}
        mode={keyboardMode}
        onCollapse={hideKeyboard}
        onMode={switchKeyboardMode}
        sendKey={(code, down, modifiers, repeat) => remote.controller?.sendKey(code, down, modifiers, repeat)}
      />
    </Animated.View> : virtualKeyboardInteractive ? <RemoteDesktopVirtualKeyboard
      bottomInset={insets.bottom}
      enabled={snapshot.inputEnabled && snapshot.isController && !snapshot.paused}
      mode={keyboardMode}
      onCollapse={hideKeyboard}
      onMode={switchKeyboardMode}
      sendKey={(code, down, modifiers, repeat) => remote.controller?.sendKey(code, down, modifiers, repeat)}
    /> : null}

    {showVideo && snapshot.phase !== 'error' && snapshot.phase !== 'stopped' ? <RemoteDesktopToolbar
      bottomInset={insets.bottom}
      hidden={keyboardVisible}
      keyboardVisible={keyboardVisible}
      mouseMode={remote.preferences.mouseMode}
      obscured={Platform.OS === 'ios' && keyboardVisible}
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
      onSelect={(target) => {
        stoppedSessionLink.current = false;
        remote.setTarget(target);
      }}
      target={snapshot.target}
      visible={sourcePicker}
    />
    <RemoteDesktopConnectionInfo onClose={() => setConnectionInfo(false)} snapshot={snapshot} sources={connectionSources} visible={connectionInfo} />
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
  landscapeShell: { flex: 1, flexDirection: 'row', minHeight: 0 },
  landscapeRail: { backgroundColor: 'rgba(15,16,18,0.98)', borderRightColor: 'rgba(255,255,255,0.12)', borderRightWidth: StyleSheet.hairlineWidth, flexDirection: 'column', flexShrink: 0, gap: 8, zIndex: 2 },
  landscapeRailActions: { gap: 6, marginTop: 'auto' },
  landscapeRailButton: { alignItems: 'center', alignSelf: 'center', borderRadius: 10, height: 44, justifyContent: 'center', width: 44 },
  landscapeTransportButton: { height: 44, marginLeft: 0, width: 44 },
  landscapeSource: { alignItems: 'center', alignSelf: 'stretch', borderRadius: 12, gap: 8, minWidth: 0, paddingBottom: 4, paddingTop: 2 },
  landscapeSourceIconWrap: { height: 30, position: 'relative', width: 30 },
  landscapeSourceIcon: { alignItems: 'center', borderRadius: 8, height: 30, justifyContent: 'center', width: 30 },
  landscapeStatusDot: { borderColor: 'rgba(15,16,18,0.98)', borderRadius: 5, borderWidth: 1.5, height: 9, position: 'absolute', right: -2, top: -2, width: 9 },
  landscapeViewers: { alignItems: 'center', flexDirection: 'row', gap: 2 },
  landscapeViewerCount: { color: 'rgba(255,255,255,0.58)', fontSize: 11, lineHeight: 14 },
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
  stageClip: { overflow: 'hidden' },
  stageContent: { flex: 1 },
  centered: { alignItems: 'center', flex: 1, gap: 10, justifyContent: 'center', padding: 30 },
  centeredTitle: { color: '#fff', fontSize: 17, fontWeight: '500', lineHeight: 23, textAlign: 'center' },
  centeredDetail: { color: 'rgba(255,255,255,0.64)', fontSize: 13, lineHeight: 19, maxWidth: 360, textAlign: 'center' },
  centeredAction: { backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 10, marginTop: 4, paddingHorizontal: 18, paddingVertical: 9 },
  centeredActionText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  errorBanner: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, bottom: 72, flexDirection: 'row', gap: 9, left: 12, paddingHorizontal: 12, paddingVertical: 9, position: 'absolute', right: 12 },
  errorText: { flex: 1, fontSize: 12, lineHeight: 17 },
  bannerAction: { fontSize: 13, fontWeight: '500' },
  keyboardDock: { backgroundColor: 'rgba(20,21,25,0.98)', borderTopColor: 'rgba(255,255,255,0.12)', borderTopWidth: StyleSheet.hairlineWidth, zIndex: 4 },
  keyboardDockAbsolute: { left: 0, position: 'absolute', right: 0 },
  keyboardDockFlow: { flexShrink: 0 },
  virtualKeyboardDock: { bottom: 0, left: 0, position: 'absolute', right: 0, zIndex: 4 },
  waiting: { alignItems: 'center', alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14, flexDirection: 'row', gap: 8, paddingHorizontal: 13, paddingVertical: 9, position: 'absolute', top: '45%' },
  waitingText: { color: '#fff', fontSize: 13, lineHeight: 18 },
  hiddenInput: { height: 1, opacity: 0.01, position: 'absolute', width: 1 },
  pressed: { opacity: 0.58 },
});
