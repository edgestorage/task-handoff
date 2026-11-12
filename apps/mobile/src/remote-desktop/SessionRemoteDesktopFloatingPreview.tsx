import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { RemoteDesktopVideoSurface } from './RemoteDesktopVideoSurface';
import { sourceTargetLabel } from './source-label';
import { useRemoteDesktop } from './use-remote-desktop';

export function SessionRemoteDesktopFloatingPreview({
  instanceId,
  onClose,
  onOpen,
  sessionId,
  visible,
}: {
  instanceId: string;
  onClose(): void;
  onOpen(): void;
  sessionId: string;
  visible: boolean;
}) {
  if (!visible) return null;
  return <FloatingPreviewContent
    instanceId={instanceId}
    onClose={onClose}
    onOpen={onOpen}
    sessionId={sessionId}
  />;
}

function FloatingPreviewContent({
  instanceId,
  onClose,
  onOpen,
  sessionId,
}: {
  instanceId: string;
  onClose(): void;
  onOpen(): void;
  sessionId: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const remote = useRemoteDesktop(instanceId, { interactive: false, sessionId });
  const width = Math.min(244, Math.max(188, window.width * 0.5));
  const mediaHeight = Math.round(width * 9 / 16);
  const title = sourceTargetLabel(remote.snapshot.target, t);
  const hasVideo = remote.snapshot.phase === 'connected'
    || remote.snapshot.phase === 'paused'
    || remote.snapshot.phase === 'reconnecting'
    || Boolean(remote.snapshot.path);
  const connectionText = remote.snapshot.phase === 'error'
    ? t('remoteDesktop.error')
    : remote.snapshot.phase === 'stopped'
      ? t('remoteDesktop.stopped')
      : remote.snapshot.phase === 'connected'
        ? t('remoteDesktop.connected')
        : t('remoteDesktop.connecting');

  return <View pointerEvents="box-none" style={[styles.host, { bottom: insets.bottom + 92 }]}>
    <Pressable
      accessibilityHint={t('remoteDesktop.previewHint')}
      accessibilityLabel={`${t('remoteDesktop.open')}: ${title}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.card, {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        width,
      }, pressed && styles.pressed]}
      testID="session-remote-desktop-floating-preview"
    >
      <View style={[styles.media, { height: mediaHeight }]}>
        <RemoteDesktopVideoSurface snapshot={remote.snapshot} />
        {!hasVideo ? <View pointerEvents="none" style={styles.placeholder}>
          <Icon color="rgba(255,255,255,0.72)" name="desktop-outline" size={24} />
          {remote.ready ? <ActivityIndicator color="rgba(255,255,255,0.78)" size="small" /> : null}
        </View> : null}
        <View pointerEvents="none" style={styles.status}>
          <View style={[styles.statusDot, {
            backgroundColor: remote.snapshot.phase === 'error' || remote.snapshot.phase === 'stopped'
              ? colors.error
              : remote.snapshot.phase === 'connected' ? '#34c759' : '#ffb340',
          }]} />
          <Text numberOfLines={1} style={styles.statusText}>{connectionText}</Text>
        </View>
      </View>
      <View style={styles.captureRow}>
        <View style={styles.captureCopy}>
          <Text numberOfLines={1} style={[styles.captureTitle, { color: colors.text }]}>{title}</Text>
          <Text numberOfLines={1} style={[styles.captureSubtitle, { color: colors.textMuted }]}>{remote.snapshot.target.subtitle || t('remoteDesktop.lastOpened')}</Text>
        </View>
        <Icon color={colors.textMuted} name="chevron-forward" size={16} />
      </View>
    </Pressable>
    <Pressable
      accessibilityLabel={t('remoteDesktop.closePreview')}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onClose}
      style={({ pressed }) => [styles.close, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}
      testID="session-remote-desktop-floating-preview-close"
    >
      <Icon color={colors.text} name="close" size={16} />
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  host: { alignItems: 'flex-end', position: 'absolute', right: 16, zIndex: 20 },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 8,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { height: 5, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
  },
  pressed: { opacity: 0.82 },
  media: { backgroundColor: '#000', overflow: 'hidden' },
  placeholder: { alignItems: 'center', bottom: 0, gap: 8, justifyContent: 'center', left: 0, position: 'absolute', right: 0, top: 0 },
  status: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.58)',
    borderRadius: 999,
    bottom: 8,
    flexDirection: 'row',
    gap: 5,
    left: 8,
    maxWidth: '70%',
    paddingHorizontal: 8,
    paddingVertical: 4,
    position: 'absolute',
  },
  statusDot: { borderRadius: 4, height: 7, width: 7 },
  statusText: { color: '#fff', fontSize: 11, lineHeight: 14 },
  captureRow: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 52, paddingHorizontal: 12 },
  captureCopy: { flex: 1, minWidth: 0 },
  captureTitle: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  captureSubtitle: { fontSize: 11, lineHeight: 15 },
  close: {
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    height: 28,
    justifyContent: 'center',
    position: 'absolute',
    right: -8,
    top: -8,
    width: 28,
  },
});
