import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { mobileWebMetric } from '../components/mobile-web-typography';
import { floatingPreviewMediaAspectRatio } from './floating-preview-layout';
import type { RemoteDesktopSize } from './geometry';
import type { RemoteDesktopResolution } from './preferences';
import { RemoteDesktopVideoSurface } from './RemoteDesktopVideoSurface';
import { useRemoteDesktop } from './use-remote-desktop';

const PREVIEW_RESOLUTION: RemoteDesktopResolution = '540p';
export const INLINE_PREVIEW_MAX_HEIGHT = mobileWebMetric(280);

export function inlinePreviewHeight(width: number, mediaAspectRatio: number) {
  return Math.max(1, Math.min(INLINE_PREVIEW_MAX_HEIGHT, Math.round(Math.max(0, width) * mediaAspectRatio)));
}

export function SessionRemoteDesktopInlinePreview({
  instanceId,
  onOpenDetail,
  sessionId,
}: {
  instanceId: string;
  onOpenDetail(): void;
  sessionId: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const window = useWindowDimensions();
  const [hostWidth, setHostWidth] = useState(() => Math.max(1, window.width - 32));
  const remote = useRemoteDesktop(instanceId, {
    interactive: false,
    resolutionOverride: PREVIEW_RESOLUTION,
    sessionId,
  });
  const streamTargetKey = `${remote.snapshot.target.kind}:${remote.snapshot.target.sourceRef || 'visible'}`;
  const [streamSize, setStreamSize] = useState<RemoteDesktopSize & { targetKey: string }>({
    height: 0,
    targetKey: streamTargetKey,
    width: 0,
  });
  const activeStreamSize = streamSize.targetKey === streamTargetKey ? streamSize : { width: 0, height: 0 };
  const liveStreamSize = remote.snapshot.path === 'websocket'
    ? { width: remote.snapshot.videoWidth, height: remote.snapshot.videoHeight }
    : activeStreamSize.width > 0 && activeStreamSize.height > 0
      ? activeStreamSize
      : { width: remote.snapshot.videoWidth, height: remote.snapshot.videoHeight };
  const mediaAspectRatio = useMemo(() => floatingPreviewMediaAspectRatio(
    liveStreamSize.width || remote.snapshot.target.width,
    liveStreamSize.height || remote.snapshot.target.height,
  ), [liveStreamSize.height, liveStreamSize.width, remote.snapshot.target.height, remote.snapshot.target.width]);
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
  const statusColor = remote.snapshot.phase === 'error' || remote.snapshot.phase === 'stopped'
    ? colors.error
    : remote.snapshot.phase === 'connected' ? '#34c759' : '#ffb340';
  const previewHeight = inlinePreviewHeight(hostWidth, mediaAspectRatio);

  return <Pressable
    accessibilityHint={t('remoteDesktop.previewHint')}
    accessibilityLabel={t('remoteDesktop.openDetails')}
    accessibilityRole="button"
    onLayout={(event) => {
      const width = Math.round(event.nativeEvent.layout.width);
      if (width > 0 && width !== hostWidth) setHostWidth(width);
    }}
    onPress={onOpenDetail}
    style={({ pressed }) => [styles.host, { height: previewHeight }, pressed && styles.pressed]}
    testID="session-remote-desktop-inline-preview"
  >
    <RemoteDesktopVideoSurface
      onStreamSizeChange={(size) => {
        remote.controller?.setVideoDimensions(size.width, size.height);
        setStreamSize((current) => current.targetKey === streamTargetKey
          && current.width === size.width
          && current.height === size.height
          ? current
          : { ...size, targetKey: streamTargetKey });
      }}
      snapshot={remote.snapshot}
    />
    {!hasVideo ? <View pointerEvents="none" style={styles.placeholder}>
      <Icon color="rgba(255,255,255,0.72)" name="desktop-outline" size={24} />
      {remote.ready ? <ActivityIndicator color="rgba(255,255,255,0.78)" size="small" /> : null}
    </View> : null}
    <View pointerEvents="none" style={styles.status}>
      <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
      <Text numberOfLines={1} style={styles.statusText}>{connectionText}</Text>
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  host: {
    alignSelf: 'stretch',
    backgroundColor: '#000',
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    minWidth: 0,
    overflow: 'hidden',
    width: '100%',
  },
  pressed: { opacity: 0.9 },
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
});
