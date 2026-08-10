import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { TerminalView, type TerminalViewRef } from 'expo-libghostty';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import { WebView } from 'react-native-webview';
import { appSessionAccessMode, type AppSessionAccessLease } from '@task-handoff/protocol/app-sessions';

import { useActiveAppSessions } from '../../../src/app-sessions/use-active-app-sessions';
import { AppSessionAccessLeaseController, shouldRenewAppSessionAccessAfterHttpStatus } from '../../../src/app-sessions/access-lease';
import { canCloseAppSession } from '../../../src/app-sessions/status';
import { AppSessionTerminalInputNormalizer } from '../../../src/app-sessions/terminal-input';
import { APP_SESSION_TERMINAL_FONT_SIZE, appSessionTerminalKeyboardBehavior, appSessionTerminalKeyboardOffset } from '../../../src/app-sessions/terminal-layout';
import { SystemIcon } from '../../../src/components/SystemIcon';
import { useMobileTheme } from '../../../src/components/theme';
import { useMobileToast } from '../../../src/components/MobileToast';
import type { MobileAppSessionTtyConnection } from '../../../src/control-plane/transport';
import { useI18n } from '../../../src/i18n';
import { subscribeToAppLifecycle } from '../../../src/platform/lifecycle';
import { subscribeToNetworkState } from '../../../src/platform/network';

type ActiveAppSessionAccess = AppSessionAccessLease & { instanceId: string; sessionId: string };

export default function AppSessionRoute() {
  const params = useLocalSearchParams<{ instanceId: string; sessionId: string }>();
  const instanceId = first(params.instanceId);
  const sessionId = first(params.sessionId);
  const router = useRouter();
  const { closeSession, createAccess, renameSession, revokeAccess, state, transport } = useActiveAppSessions();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const toast = useMobileToast();
  const terminal = useRef<TerminalViewRef>(null);
  const terminalInput = useRef(new AppSessionTerminalInputNormalizer());
  const connection = useRef<MobileAppSessionTtyConnection | undefined>(undefined);
  const renewAccessRef = useRef<(invalidateCurrent?: boolean) => void>(() => undefined);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed' | 'exited' | 'error'>('connecting');
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [access, setAccess] = useState<ActiveAppSessionAccess>();
  const session = useMemo(() => state.snapshot?.instances
    .find((entry) => entry.instanceId === instanceId)
    ?.appSessions.sessions.find((entry) => entry.id === sessionId), [instanceId, sessionId, state.snapshot]);
  const accessMode = session ? appSessionAccessMode(session) : undefined;
  const activeAccess = session?.status === 'running' && access?.instanceId === instanceId && access.sessionId === sessionId ? access : undefined;

  useEffect(() => {
    if (!transport || !instanceId || !sessionId || session?.kind !== 'tty' || session.status !== 'running') return;
    const active = transport.connectAppSessionTty(instanceId, sessionId, {
      onOpen: () => setStatus('connected'),
      onSnapshot: (data, pendingEscape) => { void terminal.current?.writeText(`\x1bc${data}${pendingEscape}`); },
      onOutput: (data) => { void terminal.current?.writeText(data); },
      onResize: () => undefined,
      onExit: (code) => {
        void terminal.current?.finish(code ?? 0);
        setStatus('exited');
      },
      onError: (cause) => {
        setError(cause.message);
        setStatus('error');
      },
      onClose: () => setStatus((current) => current === 'exited' ? current : 'closed'),
    });
    connection.current = active;
    return () => {
      connection.current = undefined;
      active.close();
    };
  }, [instanceId, session?.kind, session?.status, sessionId, transport]);

  useEffect(() => {
    if (!instanceId || !sessionId || accessMode !== 'vnc' || session?.status !== 'running') return;
    let foreground = false;
    let previousPhase: string | undefined;
    let previousConnected: boolean | undefined;
    const leases = new AppSessionAccessLeaseController({
      create: async () => {
        const created = await createAccess(instanceId, sessionId);
        if (created.mode !== 'vnc') throw new Error('The Control Plane returned an unexpected App Session access mode.');
        return created;
      },
      revoke: (token) => revokeAccess(instanceId, sessionId, token),
      onError: (cause) => {
        if (!cause) {
          setError('');
          return;
        }
        setError(cause instanceof Error ? cause.message : t('appSessions.viewUnavailable'));
        setStatus('error');
      },
      onLease: (created) => {
        setAccess(created ? { ...created, instanceId, sessionId } : undefined);
        if (created) setStatus('connecting');
      },
    });
    renewAccessRef.current = (invalidateCurrent) => { void leases.renew(invalidateCurrent); };
    const unsubscribeLifecycle = subscribeToAppLifecycle((phase) => {
      foreground = phase === 'active';
      if (phase === 'active' && previousPhase !== 'active') void leases.renew();
      previousPhase = phase;
    });
    const unsubscribeNetwork = subscribeToNetworkState((network) => {
      if (foreground && network.connected && previousConnected === false) void leases.renew();
      previousConnected = network.connected;
    });
    void leases.start();
    return () => {
      renewAccessRef.current = () => undefined;
      unsubscribeLifecycle();
      unsubscribeNetwork();
      leases.stop();
    };
  }, [accessMode, createAccess, instanceId, revokeAccess, session?.status, sessionId, t]);

  const title = session?.title || session?.appId || t('nav.appSessions');
  const closeDisabled = closing || state.sync.phase !== 'ready' || session?.status === 'stopping';
  const renameDisabled = renaming || state.sync.phase !== 'ready';
  const openRename = () => {
    setRenameDraft(title);
    setRenameError('');
    setRenameOpen(true);
  };
  const submitRename = () => {
    const nextTitle = renameDraft.trim();
    if (!nextTitle) {
      setRenameError(t('appSessions.titleRequired'));
      return;
    }
    if (nextTitle === title) {
      setRenameOpen(false);
      return;
    }
    setRenaming(true);
    setRenameError('');
    void renameSession(instanceId, sessionId, nextTitle).then(() => {
      setRenameOpen(false);
    }).catch((cause) => {
      toast.show({
        detail: cause instanceof Error && cause.message ? cause.message : t('appSessions.renameFailed'),
        title: t('toast.actionFailed', { action: t('appSessions.rename') }),
        tone: 'error',
      });
    }).finally(() => setRenaming(false));
  };
  const confirmClose = () => Alert.alert(t('appSessions.closeConfirmTitle', { name: title }), t('appSessions.closeConfirmDescription'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('appSessions.closeSession'), style: 'destructive', onPress: () => {
      setClosing(true);
      void closeSession(instanceId, sessionId).then(() => {
        connection.current?.close();
        setClosing(false);
        router.back();
      }).catch((cause) => {
        setClosing(false);
        Alert.alert(t('appSessions.closeFailed'), cause instanceof Error ? cause.message : undefined);
      });
    } },
  ]);
  const menuActions: MenuAction[] = [
    { id: 'rename', image: 'pencil', title: renaming ? t('appSessions.renaming') : t('appSessions.rename'), attributes: { disabled: renameDisabled } },
  ];
  if (session && canCloseAppSession(session.status)) {
    menuActions.push({ id: 'close', image: 'xmark.circle', title: closing || session.status === 'stopping' ? t('appSessions.closing') : t('appSessions.closeSession'), attributes: { destructive: true, disabled: closeDisabled } });
  }
  const header = <Stack.Screen options={{
    title,
    headerRight: session ? () => <MenuView
      actions={menuActions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === 'rename') openRename();
        else if (nativeEvent.event === 'close') confirmClose();
      }}
      title={t('appSessions.moreActions')}
    >
      <Pressable accessibilityLabel={t('appSessions.moreActions')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}>
        <SystemIcon android="more_horiz" color={colors.primary} ios="ellipsis.circle" size={23} />
      </Pressable>
    </MenuView> : undefined,
  }} />;

  if (!session || (accessMode !== 'tty' && accessMode !== 'vnc')) {
    return <>{header}<View style={[styles.unavailable, { backgroundColor: colors.code }]}><Text style={[styles.unavailableText, { color: colors.codeText }]}>{t('appSessions.viewUnavailable')}</Text></View></>;
  }

  const statusText = error || (status === 'connecting' ? t('appSessions.terminalConnecting') : status === 'connected' ? t('appSessions.terminalConnected') : status === 'exited' ? t('appSessions.terminalExited') : t('appSessions.terminalClosed'));
  const content = accessMode === 'tty' ? <TerminalView
    ref={terminal}
    fontSize={APP_SESSION_TERMINAL_FONT_SIZE}
    onInput={({ nativeEvent }) => {
      const input = terminalInput.current.push(nativeEvent.text);
      if (input) connection.current?.sendInput(input);
    }}
    onResize={({ nativeEvent }) => connection.current?.resize(nativeEvent.cols, nativeEvent.rows)}
    style={styles.terminal}
    theme={{ background: colors.code, foreground: colors.codeText, cursorColor: colors.sessionActive, selectionBackground: colors.primarySoft }}
  /> : activeAccess ? <WebView
    key={activeAccess.token}
    allowsFullscreenVideo
    domStorageEnabled
    javaScriptEnabled
    onError={({ nativeEvent }) => {
      setError(nativeEvent.description || t('appSessions.viewUnavailable'));
      setStatus('error');
    }}
    onHttpError={({ nativeEvent }) => {
      if (shouldRenewAppSessionAccessAfterHttpStatus(nativeEvent.statusCode)) {
        setError('');
        setStatus('connecting');
        renewAccessRef.current(true);
        return;
      }
      setError(`${t('appSessions.viewUnavailable')} (${nativeEvent.statusCode})`);
      setStatus('error');
    }}
    onLoadEnd={() => setStatus((current) => current === 'error' ? current : 'connected')}
    onLoadStart={() => setStatus('connecting')}
    onShouldStartLoadWithRequest={({ url }) => sameOriginOrLocalDocument(url, activeAccess.url)}
    originWhitelist={[new URL(activeAccess.url).origin]}
    sharedCookiesEnabled={false}
    source={{ uri: activeAccess.url }}
    style={styles.webView}
    thirdPartyCookiesEnabled={false}
  /> : null;
  const sessionContent = <>{content}
    {status !== 'connected' ? <View pointerEvents="none" style={[styles.status, { backgroundColor: colors.surface }]}><Text numberOfLines={2} style={[styles.statusText, { color: status === 'error' ? colors.error : colors.textMuted }]}>{statusText}</Text></View> : null}</>;
  return <>{header}{accessMode === 'tty' ? <View style={[styles.screen, styles.terminalKeyboardBackground]} testID="app-session-terminal-keyboard-background">
    <KeyboardAvoidingView
      behavior={appSessionTerminalKeyboardBehavior(Platform.OS)}
      keyboardVerticalOffset={appSessionTerminalKeyboardOffset(Platform.OS, Platform.Version)}
      style={[styles.screen, styles.terminalKeyboardBackground]}
      testID="app-session-terminal-keyboard-area"
    >{sessionContent}</KeyboardAvoidingView>
  </View> : <View style={[styles.screen, { backgroundColor: colors.code }]}>{sessionContent}</View>}<Modal animationType="fade" onRequestClose={() => !renaming && setRenameOpen(false)} transparent visible={renameOpen}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.renameOverlay}>
      <Pressable disabled={renaming} onPress={() => setRenameOpen(false)} style={styles.renameBackdrop} />
      <View style={[styles.renameDialog, { backgroundColor: colors.surface }]}>
        <Text style={[styles.renameTitle, { color: colors.text }]}>{t('appSessions.rename')}</Text>
        <TextInput
          autoFocus
          editable={!renaming}
          maxLength={120}
          onChangeText={(value) => { setRenameDraft(value); setRenameError(''); }}
          onSubmitEditing={submitRename}
          placeholder={t('appSessions.renamePlaceholder')}
          placeholderTextColor={colors.textMuted}
          returnKeyType="done"
          selectTextOnFocus
          style={[styles.renameInput, { borderColor: renameError ? colors.error : colors.border, color: colors.text }]}
          value={renameDraft}
        />
        {renameError ? <Text accessibilityLiveRegion="polite" style={[styles.renameError, { color: colors.error }]}>{renameError}</Text> : null}
        <View style={styles.renameActions}>
          <Pressable disabled={renaming} onPress={() => setRenameOpen(false)} style={({ pressed }) => [styles.renameAction, pressed && styles.menuButtonPressed]}><Text style={[styles.renameActionText, { color: colors.textMuted }]}>{t('common.cancel')}</Text></Pressable>
          <Pressable disabled={renaming} onPress={submitRename} style={({ pressed }) => [styles.renameAction, renaming && styles.renameActionDisabled, pressed && styles.menuButtonPressed]}><Text style={[styles.renameActionText, { color: colors.primary }]}>{renaming ? t('appSessions.renaming') : t('appSessions.rename')}</Text></Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal></>;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function sameOriginOrLocalDocument(url: string, accessUrl: string) {
  if (url === 'about:blank') return true;
  try {
    return new URL(url).origin === new URL(accessUrl).origin;
  } catch {
    return false;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  terminal: { flex: 1 },
  terminalKeyboardBackground: { backgroundColor: '#000000' },
  webView: { flex: 1 },
  status: { borderRadius: 9, left: 12, maxWidth: '85%', paddingHorizontal: 10, paddingVertical: 7, position: 'absolute', top: 10 },
  statusText: { fontSize: 12, lineHeight: 16 },
  menuButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
  menuButtonPressed: { opacity: 0.65 },
  renameOverlay: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
  renameBackdrop: { backgroundColor: 'rgba(0,0,0,0.35)', bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  renameDialog: { borderRadius: 16, gap: 12, maxWidth: 420, padding: 18, width: '100%' },
  renameTitle: { fontSize: 18, fontWeight: '700', lineHeight: 24 },
  renameInput: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 16, minHeight: 44, paddingHorizontal: 12, paddingVertical: 9 },
  renameError: { fontSize: 13, lineHeight: 18 },
  renameActions: { flexDirection: 'row', justifyContent: 'flex-end' },
  renameAction: { alignItems: 'center', justifyContent: 'center', minHeight: 40, paddingHorizontal: 12 },
  renameActionDisabled: { opacity: 0.45 },
  renameActionText: { fontSize: 15, fontWeight: '600' },
  unavailable: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
  unavailableText: { fontSize: 14, textAlign: 'center' },
});
