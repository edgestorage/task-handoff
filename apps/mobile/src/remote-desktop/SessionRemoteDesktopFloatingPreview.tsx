import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import {
  clampFloatingPreview,
  clampFloatingPreviewFrame,
  DEFAULT_FLOATING_PREVIEW_PREFERENCE,
  floatingPreviewMediaAspectRatio,
  floatingPreviewLayout,
  floatingPreviewPreferenceForFrame,
  floatingPreviewPreferenceForCollapse,
  FLOATING_PREVIEW_MAX_WIDTH,
  FLOATING_PREVIEW_MIN_WIDTH,
  resistedFloatingPreviewDrag,
  resizeFloatingPreviewFrame,
  type FloatingPreviewFrame,
  type FloatingPreviewLayout,
  type FloatingPreviewPreference,
  type FloatingPreviewViewport,
} from './floating-preview-layout';
import {
  FLOATING_PREVIEW_ENTER_DURATION_MS,
  FLOATING_PREVIEW_EXIT_DURATION_MS,
  FLOATING_PREVIEW_PRESENCE_OFFSET,
  FLOATING_PREVIEW_PRESENCE_SCALE,
  useFloatingPreviewPresence,
} from './floating-preview-presence';
import type { RemoteDesktopSize } from './geometry';
import type { RemoteDesktopResolution } from './preferences';
import { remoteDesktopPreviewStatus, remoteDesktopPreviewStatusColor } from './preview-status';
import { RemoteDesktopVideoSurface } from './RemoteDesktopVideoSurface';
import {
  updateSessionFloatingPreviewPreference,
  useSessionFloatingPreviewPreference,
} from './session-floating-preview-preferences';
import { sourceTargetLabel } from './source-label';
import { useRemoteDesktop } from './use-remote-desktop';

const PREVIEW_RESOLUTION: RemoteDesktopResolution = '540p';
const DRAG_THRESHOLD = 4;
const PRESS_SUPPRESSION_AFTER_GESTURE_MS = 120;
const RESIZE_ACCESSIBILITY_STEP = 24;

type GestureContext = {
  applyFrame(frame: FloatingPreviewFrame, animate: boolean): void;
  layout: FloatingPreviewLayout;
  mediaAspectRatio: number;
  persistFrame(frame: FloatingPreviewFrame, collapsed: boolean, expandedWidth: number): void;
  preference: FloatingPreviewPreference;
  stopAnimations(): void;
  viewport: FloatingPreviewViewport;
};

export function SessionRemoteDesktopFloatingPreview({
  controlPlaneId,
  instanceId,
  onClose,
  onOpen,
  sessionId,
  topInset = 0,
  visible,
}: {
  controlPlaneId?: string;
  instanceId: string;
  onClose(): void;
  onOpen(): void;
  sessionId: string;
  topInset?: number;
  visible: boolean;
}) {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);
  const present = useFloatingPreviewPresence(visible, reduceMotion);
  if (!present) return null;
  return <FloatingPreviewContent
    controlPlaneId={controlPlaneId}
    instanceId={instanceId}
    onClose={onClose}
    onOpen={onOpen}
    reduceMotion={reduceMotion}
    sessionId={sessionId}
    topInset={topInset}
    visible={visible}
  />;
}

function FloatingPreviewContent({
  controlPlaneId,
  instanceId,
  onClose,
  onOpen,
  reduceMotion,
  sessionId,
  topInset,
  visible,
}: {
  controlPlaneId?: string;
  instanceId: string;
  onClose(): void;
  onOpen(): void;
  reduceMotion: boolean;
  sessionId: string;
  topInset: number;
  visible: boolean;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
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
  const preference = useSessionFloatingPreviewPreference(controlPlaneId, instanceId, sessionId);
  const viewport = useMemo<FloatingPreviewViewport>(() => ({
    height: window.height,
    insets: { ...insets, top: Math.max(0, insets.top, topInset) },
    width: window.width,
  }), [insets, topInset, window.height, window.width]);
  const layout = useMemo(() => floatingPreviewLayout(viewport, preference, mediaAspectRatio), [mediaAspectRatio, preference, viewport]);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [position] = useState(() => new Animated.ValueXY({ x: layout.frame.x, y: layout.frame.y }));
  const [widthValue] = useState(() => new Animated.Value(layout.frame.width));
  const [heightValue] = useState(() => new Animated.Value(layout.frame.height));
  const [presence] = useState(() => new Animated.Value(visible ? 0 : 1));
  const frameRef = useRef(layout.frame);
  const dragStartRef = useRef(layout.frame);
  const resizeStartRef = useRef(layout.frame);
  const pressSuppressionUntilRef = useRef(0);

  const stopAnimations = useCallback(() => {
    position.stopAnimation();
    widthValue.stopAnimation();
    heightValue.stopAnimation();
  }, [heightValue, position, widthValue]);

  const applyFrame = useCallback((frame: FloatingPreviewFrame, animate: boolean) => {
    stopAnimations();
    frameRef.current = frame;
    if (!animate || reduceMotion) {
      position.setValue({ x: frame.x, y: frame.y });
      widthValue.setValue(frame.width);
      heightValue.setValue(frame.height);
      return;
    }
    Animated.parallel([
      Animated.spring(position, {
        damping: 24,
        mass: 0.8,
        overshootClamping: true,
        stiffness: 280,
        toValue: { x: frame.x, y: frame.y },
        useNativeDriver: false,
      }),
      Animated.spring(widthValue, {
        damping: 24,
        mass: 0.8,
        overshootClamping: true,
        stiffness: 280,
        toValue: frame.width,
        useNativeDriver: false,
      }),
      Animated.spring(heightValue, {
        damping: 24,
        mass: 0.8,
        overshootClamping: true,
        stiffness: 280,
        toValue: frame.height,
        useNativeDriver: false,
      }),
    ]).start();
  }, [heightValue, position, reduceMotion, stopAnimations, widthValue]);

  const persistFrame = useCallback((
    frame: FloatingPreviewFrame,
    collapsed: boolean,
    expandedWidth: number,
  ) => {
    updateSessionFloatingPreviewPreference({
      controlPlaneId,
      instanceId,
      preference: floatingPreviewPreferenceForFrame({ collapsed, expandedWidth, frame, mediaAspectRatio, viewport }),
      sessionId,
    });
  }, [controlPlaneId, instanceId, mediaAspectRatio, sessionId, viewport]);

  const gestureContext = useRef<GestureContext>({
    applyFrame,
    layout,
    mediaAspectRatio,
    persistFrame,
    preference: DEFAULT_FLOATING_PREVIEW_PREFERENCE,
    stopAnimations,
    viewport,
  });
  useLayoutEffect(() => {
    gestureContext.current = { applyFrame, layout, mediaAspectRatio, persistFrame, preference, stopAnimations, viewport };
  }, [applyFrame, layout, mediaAspectRatio, persistFrame, preference, stopAnimations, viewport]);

  useEffect(() => {
    presence.stopAnimation();
    if (reduceMotion) {
      presence.setValue(visible ? 1 : 0);
      return;
    }
    const animation = Animated.timing(presence, {
      duration: visible ? FLOATING_PREVIEW_ENTER_DURATION_MS : FLOATING_PREVIEW_EXIT_DURATION_MS,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      toValue: visible ? 1 : 0,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [presence, reduceMotion, visible]);

  useEffect(() => {
    applyFrame(layout.frame, true);
  }, [applyFrame, layout.frame]);

  const toggleCollapsed = useCallback((collapsed: boolean) => {
    const current = gestureContext.current;
    const frame = frameRef.current;
    const nextPreference = floatingPreviewPreferenceForCollapse({
      collapsed,
      preference: current.preference,
      frame,
      mediaAspectRatio: current.mediaAspectRatio,
      viewport: current.viewport,
    });
    current.applyFrame(floatingPreviewLayout(current.viewport, nextPreference, current.mediaAspectRatio).frame, true);
    updateSessionFloatingPreviewPreference({
      controlPlaneId,
      instanceId,
      preference: nextPreference,
      sessionId,
    });
  }, [controlPlaneId, instanceId, sessionId]);

  // PanResponder retains these callbacks; gestureContext keeps them current without rerendering the card.
  // eslint-disable-next-line react-hooks/refs
  const [dragPanResponder] = useState(() => PanResponder.create({
    onMoveShouldSetPanResponder: shouldStartGesture,
    onMoveShouldSetPanResponderCapture: shouldStartGesture,
    onPanResponderGrant: () => {
      const current = gestureContext.current;
      current.stopAnimations();
      dragStartRef.current = frameRef.current;
      pressSuppressionUntilRef.current = Number.POSITIVE_INFINITY;
      setDragging(true);
    },
    onPanResponderMove: (_event, gesture) => {
      const current = gestureContext.current;
      const start = dragStartRef.current;
      const bounds = current.layout.bounds;
      const frame = {
        ...start,
        x: resistedFloatingPreviewDrag(start.x + gesture.dx, bounds.minX, bounds.maxX),
        y: clampFloatingPreview(start.y + gesture.dy, bounds.minY, bounds.maxY),
      };
      current.applyFrame(frame, false);
    },
    onPanResponderRelease: (_event, gesture) => {
      const current = gestureContext.current;
      const start = dragStartRef.current;
      const frame = clampFloatingPreviewFrame({
        ...start,
        x: start.x + gesture.dx,
        y: start.y + gesture.dy,
      }, current.viewport, current.mediaAspectRatio);
      current.applyFrame(frame, true);
      current.persistFrame(frame, current.preference.collapsed, current.preference.collapsed ? current.preference.width : frame.width);
      setDragging(false);
      pressSuppressionUntilRef.current = Date.now() + PRESS_SUPPRESSION_AFTER_GESTURE_MS;
    },
    onPanResponderTerminate: () => {
      const current = gestureContext.current;
      const frame = clampFloatingPreviewFrame(frameRef.current, current.viewport, current.mediaAspectRatio);
      current.applyFrame(frame, true);
      current.persistFrame(frame, current.preference.collapsed, current.preference.collapsed ? current.preference.width : frame.width);
      setDragging(false);
      pressSuppressionUntilRef.current = Date.now() + PRESS_SUPPRESSION_AFTER_GESTURE_MS;
    },
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }));

  // eslint-disable-next-line react-hooks/refs
  const [resizeResponders] = useState(() => {
    const create = (edge: 'left' | 'right') => PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        gestureContext.current.stopAnimations();
        resizeStartRef.current = frameRef.current;
        pressSuppressionUntilRef.current = Number.POSITIVE_INFINITY;
        setResizing(true);
      },
      onPanResponderMove: (_event, gesture) => {
        const frame = resizeFloatingPreviewFrame({
          dx: gesture.dx,
          dy: gesture.dy,
          edge,
          mediaAspectRatio: gestureContext.current.mediaAspectRatio,
          start: resizeStartRef.current,
          viewport: gestureContext.current.viewport,
        });
        gestureContext.current.applyFrame(frame, false);
      },
      onPanResponderRelease: (_event, gesture) => {
        const current = gestureContext.current;
        const frame = resizeFloatingPreviewFrame({ dx: gesture.dx, dy: gesture.dy, edge, mediaAspectRatio: current.mediaAspectRatio, start: resizeStartRef.current, viewport: current.viewport });
        current.applyFrame(frame, true);
        current.persistFrame(frame, false, frame.width);
        setResizing(false);
        pressSuppressionUntilRef.current = Date.now() + PRESS_SUPPRESSION_AFTER_GESTURE_MS;
      },
      onPanResponderTerminate: () => {
        const current = gestureContext.current;
        current.applyFrame(frameRef.current, true);
        current.persistFrame(frameRef.current, false, frameRef.current.width);
        setResizing(false);
        pressSuppressionUntilRef.current = Date.now() + PRESS_SUPPRESSION_AFTER_GESTURE_MS;
      },
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    });
    return { left: create('left'), right: create('right') };
  });

  function adjustSize(edge: 'left' | 'right', direction: 'increment' | 'decrement') {
    const current = gestureContext.current;
    const delta = direction === 'increment' ? RESIZE_ACCESSIBILITY_STEP : -RESIZE_ACCESSIBILITY_STEP;
    const frame = resizeFloatingPreviewFrame({
      dx: edge === 'left' ? -delta : delta,
      edge,
      mediaAspectRatio: current.mediaAspectRatio,
      start: frameRef.current,
      viewport: current.viewport,
    });
    current.applyFrame(frame, true);
    current.persistFrame(frame, false, frame.width);
    pressSuppressionUntilRef.current = Date.now() + PRESS_SUPPRESSION_AFTER_GESTURE_MS;
  }

  function pressAllowed() {
    return Date.now() >= pressSuppressionUntilRef.current;
  }

  const title = sourceTargetLabel(remote.snapshot.target, t);
  const hasVideo = remote.snapshot.phase === 'connected'
    || remote.snapshot.phase === 'paused'
    || remote.snapshot.phase === 'reconnecting'
    || Boolean(remote.snapshot.path);
  const status = remoteDesktopPreviewStatus(remote.snapshot, t);
  const statusColor = remoteDesktopPreviewStatusColor(status.tone, colors.error);
  const presenceScale = presence.interpolate({
    inputRange: [0, 1],
    outputRange: [FLOATING_PREVIEW_PRESENCE_SCALE, 1],
  });
  const presenceOffset = presence.interpolate({
    inputRange: [0, 1],
    outputRange: [FLOATING_PREVIEW_PRESENCE_OFFSET, 0],
  });

  return <Animated.View
    pointerEvents={visible ? 'auto' : 'none'}
    style={[styles.host, {
      backgroundColor: colors.surface,
      height: heightValue,
      left: position.x,
      opacity: presence,
      top: position.y,
      transform: [
        { scale: presenceScale },
        { scale: dragging || resizing ? 1.02 : 1 },
        { translateY: presenceOffset },
      ],
      width: widthValue,
    }]}
    testID="session-remote-desktop-floating-preview-container"
    {...dragPanResponder.panHandlers}
  >
    <Pressable
      accessibilityLabel={preference.collapsed
        ? `${t('remoteDesktop.expandPreview')}: ${title}`
        : `${t('remoteDesktop.open')}: ${title}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: !preference.collapsed }}
      onPress={() => {
        if (!pressAllowed()) return;
        if (preference.collapsed) toggleCollapsed(false);
        else onOpen();
      }}
      onPressIn={() => { pressSuppressionUntilRef.current = 0; }}
      style={({ pressed }) => [styles.card, {
        backgroundColor: colors.surface,
        borderColor: colors.border,
      }, pressed && styles.pressed]}
      testID="session-remote-desktop-floating-preview"
    >
      {preference.collapsed ? <View style={styles.collapsedRow}>
        <View style={[styles.collapsedIcon, { backgroundColor: colors.primarySoft }]}>
          <Icon color={colors.primary} name="desktop-outline" size={18} />
        </View>
        <Text numberOfLines={1} style={[styles.collapsedTitle, { color: colors.text }]}>{title}</Text>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        <Icon color={colors.textMuted} name="chevron-up" size={16} />
      </View> : <View style={styles.expandedContent}>
        <View style={styles.media}>
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
            {remote.ready && status.tone === 'pending' ? <ActivityIndicator color="rgba(255,255,255,0.78)" size="small" /> : null}
          </View> : null}
          <View pointerEvents="none" style={styles.status}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text numberOfLines={1} style={styles.statusText}>{status.label}</Text>
          </View>
        </View>
        <View style={styles.captureRow}>
          <View style={styles.captureCopy}>
            <Text numberOfLines={1} style={[styles.captureTitle, { color: colors.text }]}>{title}</Text>
            <Text numberOfLines={1} style={[styles.captureSubtitle, { color: colors.textMuted }]}>{remote.snapshot.target.subtitle || t('remoteDesktop.lastOpened')}</Text>
          </View>
          <Pressable
            accessibilityLabel={t('remoteDesktop.collapsePreview')}
            accessibilityRole="button"
            hitSlop={8}
            onPress={(event) => {
              event.stopPropagation();
              if (pressAllowed()) toggleCollapsed(true);
            }}
            onPressIn={(event) => {
              event.stopPropagation();
              pressSuppressionUntilRef.current = 0;
            }}
            style={({ pressed }) => [styles.collapseButton, {
              backgroundColor: pressed ? colors.workbenchSelectionBackground : colors.surfaceInset,
            }]}
            testID="session-remote-desktop-floating-preview-collapse"
          >
            <Icon color={colors.textMuted} name="chevron-down" size={16} />
          </Pressable>
          <Icon color={colors.textMuted} name="chevron-forward" size={16} />
        </View>
      </View>}
    </Pressable>
    {preference.collapsed ? null : <>
      <View
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        accessibilityLabel={t('remoteDesktop.resizePreview')}
        accessibilityRole="adjustable"
        accessibilityValue={{
          max: FLOATING_PREVIEW_MAX_WIDTH,
          min: FLOATING_PREVIEW_MIN_WIDTH,
          now: Math.round(layout.frame.width),
        }}
        onAccessibilityAction={(event) => adjustSize('left', event.nativeEvent.actionName as 'increment' | 'decrement')}
        style={[styles.resizeHandle, styles.resizeHandleLeft]}
        testID="session-remote-desktop-floating-preview-resize-left"
        {...resizeResponders.left.panHandlers}
      ><View style={[styles.resizeGrip, styles.resizeGripLeft, { borderColor: colors.textMuted }]} /></View>
      <View
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        accessibilityLabel={t('remoteDesktop.resizePreview')}
        accessibilityRole="adjustable"
        accessibilityValue={{
          max: FLOATING_PREVIEW_MAX_WIDTH,
          min: FLOATING_PREVIEW_MIN_WIDTH,
          now: Math.round(layout.frame.width),
        }}
        onAccessibilityAction={(event) => adjustSize('right', event.nativeEvent.actionName as 'increment' | 'decrement')}
        style={[styles.resizeHandle, styles.resizeHandleRight]}
        testID="session-remote-desktop-floating-preview-resize-right"
        {...resizeResponders.right.panHandlers}
      ><View style={[styles.resizeGrip, styles.resizeGripRight, { borderColor: colors.textMuted }]} /></View>
    </>}
    <Pressable
      accessibilityLabel={t('remoteDesktop.closePreview')}
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => { if (pressAllowed()) onClose(); }}
      onPressIn={() => { pressSuppressionUntilRef.current = 0; }}
      style={({ pressed }) => [styles.close, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}
      testID="session-remote-desktop-floating-preview-close"
    >
      <Icon color={colors.text} name="close" size={16} />
    </Pressable>
  </Animated.View>;
}

function shouldStartGesture(_event: unknown, gesture: { dx: number; dy: number }) {
  return Math.abs(gesture.dx) >= DRAG_THRESHOLD || Math.abs(gesture.dy) >= DRAG_THRESHOLD;
}

const styles = StyleSheet.create({
  host: {
    borderRadius: 14,
    elevation: 8,
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { height: 5, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    zIndex: 20,
  },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    overflow: 'hidden',
  },
  pressed: { opacity: 0.82 },
  expandedContent: { flex: 1 },
  media: { backgroundColor: '#000', flex: 1, overflow: 'hidden' },
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
  captureRow: { alignItems: 'center', flexDirection: 'row', gap: 8, height: 52, paddingHorizontal: 12 },
  captureCopy: { flex: 1, minWidth: 0 },
  captureTitle: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  captureSubtitle: { fontSize: 11, lineHeight: 15 },
  collapseButton: { alignItems: 'center', borderRadius: 14, height: 28, justifyContent: 'center', width: 28 },
  collapsedRow: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 8, paddingHorizontal: 12 },
  collapsedIcon: { alignItems: 'center', borderRadius: 12, height: 28, justifyContent: 'center', width: 28 },
  collapsedTitle: { flex: 1, fontSize: 13, fontWeight: '500', lineHeight: 18, minWidth: 0 },
  resizeHandle: { alignItems: 'center', bottom: -15, height: 48, justifyContent: 'center', position: 'absolute', width: 48 },
  resizeHandleLeft: { left: -15 },
  resizeHandleRight: { right: -15 },
  resizeGrip: { borderBottomWidth: 1.5, height: 10, opacity: 0.55, width: 10 },
  resizeGripLeft: { borderBottomLeftRadius: 10, borderLeftWidth: 1.5 },
  resizeGripRight: { borderBottomRightRadius: 10, borderRightWidth: 1.5 },
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
