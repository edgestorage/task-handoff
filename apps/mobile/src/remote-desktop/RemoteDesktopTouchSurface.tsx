import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent, type NativeTouchEvent } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { Hand } from 'lucide-react-native';
import { RemoteDesktopWheelPump } from '@task-handoff/control-plane-client';

import RemoteDesktopSurface from '../../modules/task-handoff-remote-desktop/src/RemoteDesktopSurface';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { remoteDesktopControlHint, type RemoteDesktopControlHint } from './control-presentation';
import type { RemoteDesktopController } from './controller';
import { RemoteDesktopCursor } from './RemoteDesktopCursor';
import {
  IDENTITY_REMOTE_DESKTOP_TRANSFORM,
  constrainRemoteDesktopTransform,
  remoteDesktopContainRect,
  remoteDesktopPinchTransform,
  remoteDesktopMultiTouchIntent,
  remoteDesktopPointForTouch,
  remoteDesktopScrollAnchor,
  remoteDesktopTouchDistance,
  remoteDesktopTouchMidpoint,
  remoteDesktopTouchOrientation,
  type RemoteDesktopPoint,
  type RemoteDesktopSize,
  type RemoteDesktopTransform,
} from './geometry';
import type { RemoteDesktopMouseMode } from './preferences';
import type { RemoteDesktopSnapshot } from './types';
import { useLatestRef } from './use-latest-ref';

const TRACKPAD_DRAG_DELAY_MS = 420;
const DIRECT_PRESS_DELAY_MS = 180;
const DIRECT_MOVE_THRESHOLD = 3;

type Props = {
  controller?: RemoteDesktopController;
  mouseMode: RemoteDesktopMouseMode;
  snapshot: RemoteDesktopSnapshot;
};

type GestureMode = 'none' | 'direct-pending' | 'direct' | 'trackpad' | 'multi';
type ZoomState = { targetKey: string; transform: RemoteDesktopTransform };

export function RemoteDesktopTouchSurface({ controller, mouseMode, snapshot }: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [viewport, setViewport] = useState<RemoteDesktopSize>({ width: 0, height: 0 });
  const [streamSize, setStreamSize] = useState<RemoteDesktopSize>({ width: 0, height: 0 });
  const [controlHint, setControlHint] = useState<RemoteDesktopControlHint>();
  const targetKey = snapshot.target.sourceRef
    ? `${snapshot.target.kind}:${snapshot.target.sourceRef}`
    : `${snapshot.target.kind}:visible`;
  const [zoom, setZoom] = useState<ZoomState>({ targetKey, transform: IDENTITY_REMOTE_DESKTOP_TRANSFORM });
  const [cursor, setCursor] = useState<RemoteDesktopPoint>({ x: 0.5, y: 0.5 });
  const cursorRef = useRef(cursor);
  const controllerRef = useLatestRef(controller);
  const snapshotRef = useLatestRef(snapshot);
  const viewportRef = useLatestRef(viewport);
  const streamSizeRef = useLatestRef(streamSize);
  const contentSize = useMemo(
    () => snapshot.path === 'websocket'
      ? { width: snapshot.videoWidth, height: snapshot.videoHeight }
      : streamSize,
    [snapshot.path, snapshot.videoHeight, snapshot.videoWidth, streamSize],
  );
  const contentSizeRef = useLatestRef(contentSize);
  const mouseModeRef = useLatestRef(mouseMode);
  const gestureRef = useRef<GestureMode>('none');
  const lastMappedRef = useRef<RemoteDesktopPoint | undefined>(undefined);
  const lastTouchRef = useRef<RemoteDesktopPoint | undefined>(undefined);
  const trackpadMovedRef = useRef(false);
  const trackpadDraggingRef = useRef(false);
  const trackpadDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const directPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const directPressPointRef = useRef<RemoteDesktopPoint | undefined>(undefined);
  const wheelPumpRef = useRef(new RemoteDesktopWheelPump());
  const wheelFrameRef = useRef<number | null>(null);
  const wheelAnchorRef = useRef<RemoteDesktopPoint | undefined>(undefined);
  const flushWheelFrameRef = useRef<() => void>(() => undefined);
  const [trackpadDragging, setTrackpadDragging] = useState(false);
  const multiTouchRef = useRef<{
    start: RemoteDesktopTransform;
    startMidpoint: RemoteDesktopPoint;
    startDistance: number;
    startOrientation: 'horizontal' | 'vertical';
    lastMidpoint: RemoteDesktopPoint;
    scrollPoint: RemoteDesktopPoint;
    intent: 'pending' | 'scroll' | 'pinch';
  } | undefined>(undefined);
  const controlHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inputReady = snapshot.inputEnabled && snapshot.isController && !snapshot.paused;
  const inputReadyRef = useLatestRef(inputReady);
  const contentRect = remoteDesktopContainRect(viewport, contentSize);
  const transform = zoom.targetKey === targetKey
    ? constrainRemoteDesktopTransform(zoom.transform, viewport, contentRect)
    : IDENTITY_REMOTE_DESKTOP_TRANSFORM;
  const transformRef = useLatestRef(transform);

  const showControlHint = useCallback(() => {
    const hint = remoteDesktopControlHint(snapshotRef.current);
    if (!hint) return;
    if (controlHintTimerRef.current !== null) clearTimeout(controlHintTimerRef.current);
    setControlHint(hint);
    controlHintTimerRef.current = setTimeout(() => {
      controlHintTimerRef.current = null;
      setControlHint(undefined);
    }, 2_600);
  }, [snapshotRef]);

  const mapViewportPoint = useCallback((point: RemoteDesktopPoint, clampToContent = false) => remoteDesktopPointForTouch(
    point,
    viewportRef.current,
    contentSizeRef.current,
    transformRef.current,
    clampToContent,
  ), [contentSizeRef, transformRef, viewportRef]);

  const mapTouchClamped = useCallback((touch: NativeTouchEvent) => mapViewportPoint({
    x: touch.locationX,
    y: touch.locationY,
  }, true), [mapViewportPoint]);

  const updateTransform = useCallback((next: RemoteDesktopTransform) => {
    const constrained = constrainRemoteDesktopTransform(
      next,
      viewportRef.current,
      remoteDesktopContainRect(viewportRef.current, contentSizeRef.current),
    );
    if (constrained.scale === transformRef.current.scale
      && constrained.translateX === transformRef.current.translateX
      && constrained.translateY === transformRef.current.translateY) return;
    transformRef.current = constrained;
    setZoom({ targetKey, transform: constrained });
  }, [contentSizeRef, targetKey, transformRef, viewportRef]);

  const clearTrackpadDragTimer = useCallback(() => {
    if (trackpadDragTimerRef.current === null) return;
    clearTimeout(trackpadDragTimerRef.current);
    trackpadDragTimerRef.current = null;
  }, []);

  const clearDirectPressTimer = useCallback(() => {
    if (directPressTimerRef.current === null) return;
    clearTimeout(directPressTimerRef.current);
    directPressTimerRef.current = null;
  }, []);

  const clearWheelPump = useCallback(() => {
    wheelPumpRef.current.clear();
    wheelAnchorRef.current = undefined;
    if (wheelFrameRef.current === null) return;
    cancelAnimationFrame(wheelFrameRef.current);
    wheelFrameRef.current = null;
  }, []);

  const flushWheelFrame = useCallback(() => {
    wheelFrameRef.current = null;
    const step = wheelPumpRef.current.take();
    const anchor = wheelAnchorRef.current;
    if (step && anchor && inputReadyRef.current) {
      controllerRef.current?.sendWheel(anchor.x, anchor.y, step.x, step.y);
    }
    if (!wheelPumpRef.current.idle && inputReadyRef.current) {
      wheelFrameRef.current = requestAnimationFrame(() => flushWheelFrameRef.current());
    }
  }, [controllerRef, inputReadyRef]);

  useEffect(() => {
    flushWheelFrameRef.current = flushWheelFrame;
  }, [flushWheelFrame]);

  const queueWheel = useCallback((anchor: RemoteDesktopPoint, deltaX: number, deltaY: number) => {
    wheelAnchorRef.current = anchor;
    wheelPumpRef.current.add(deltaX, deltaY);
    if (wheelFrameRef.current !== null || wheelPumpRef.current.idle) return;
    wheelFrameRef.current = requestAnimationFrame(flushWheelFrame);
  }, [flushWheelFrame]);

  const finishTrackpadDrag = useCallback((releaseButton: boolean) => {
    clearTrackpadDragTimer();
    if (!trackpadDraggingRef.current) return;
    if (releaseButton) {
      const point = cursorRef.current;
      controllerRef.current?.sendButton(point.x, point.y, 0, false);
    }
    trackpadDraggingRef.current = false;
    setTrackpadDragging(false);
  }, [clearTrackpadDragTimer, controllerRef]);

  const beginMultiTouch = useCallback((touches: readonly NativeTouchEvent[]) => {
    if (gestureRef.current === 'multi') return;
    clearDirectPressTimer();
    directPressPointRef.current = undefined;
    if (gestureRef.current === 'direct' && lastMappedRef.current) {
      controllerRef.current?.sendButton(lastMappedRef.current.x, lastMappedRef.current.y, 0, false);
    }
    finishTrackpadDrag(true);
    clearWheelPump();
    gestureRef.current = 'multi';
    const [first, second] = touches;
    if (!first || !second) return;
    const firstPoint = { x: first.locationX, y: first.locationY };
    const secondPoint = { x: second.locationX, y: second.locationY };
    const midpoint = remoteDesktopTouchMidpoint(firstPoint, secondPoint);
    multiTouchRef.current = {
      start: transformRef.current,
      startMidpoint: midpoint,
      startDistance: remoteDesktopTouchDistance(firstPoint, secondPoint),
      startOrientation: remoteDesktopTouchOrientation(firstPoint, secondPoint),
      lastMidpoint: midpoint,
      scrollPoint: remoteDesktopScrollAnchor(mouseModeRef.current, cursorRef.current, lastMappedRef.current),
      intent: 'pending',
    };
  }, [clearDirectPressTimer, clearWheelPump, controllerRef, finishTrackpadDrag, mouseModeRef, transformRef]);

  const updateMultiTouch = useCallback((touches: readonly NativeTouchEvent[]) => {
    const multiTouch = multiTouchRef.current;
    const [first, second] = touches;
    if (!multiTouch || !first || !second) return;
    const firstPoint = { x: first.locationX, y: first.locationY };
    const secondPoint = { x: second.locationX, y: second.locationY };
    const midpoint = remoteDesktopTouchMidpoint(firstPoint, secondPoint);
    const distance = remoteDesktopTouchDistance(firstPoint, secondPoint);
    if (multiTouch.intent === 'pending') {
      multiTouch.intent = remoteDesktopMultiTouchIntent(
        multiTouch.startMidpoint,
        midpoint,
        multiTouch.startDistance,
        distance,
        multiTouch.startOrientation,
      );
    }
    if (multiTouch.intent === 'pinch') {
      updateTransform(remoteDesktopPinchTransform(
        multiTouch.start,
        multiTouch.startMidpoint,
        midpoint,
        multiTouch.startDistance,
        distance,
        viewportRef.current,
        contentSizeRef.current,
      ));
    } else if (multiTouch.intent === 'scroll') {
      const rect = remoteDesktopContainRect(viewportRef.current, contentSizeRef.current);
      const transformedWidth = rect.width * transformRef.current.scale;
      const transformedHeight = rect.height * transformRef.current.scale;
      if (transformedWidth > 0 && transformedHeight > 0) {
        const deltaX = (multiTouch.lastMidpoint.x - midpoint.x) / transformedWidth * 2_000;
        const deltaY = (multiTouch.lastMidpoint.y - midpoint.y) / transformedHeight * 2_000;
        if (Math.abs(deltaX) + Math.abs(deltaY) >= 1) queueWheel(multiTouch.scrollPoint, deltaX, deltaY);
      }
    }
    multiTouch.lastMidpoint = midpoint;
  }, [contentSizeRef, queueWheel, transformRef, updateTransform, viewportRef]);

  const commitDirectPress = useCallback(() => {
    clearDirectPressTimer();
    if (gestureRef.current !== 'direct-pending') return;
    const point = directPressPointRef.current;
    if (!point || !inputReadyRef.current) return;
    gestureRef.current = 'direct';
    controllerRef.current?.sendButton(point.x, point.y, 0, true);
  }, [clearDirectPressTimer, controllerRef, inputReadyRef]);

  const finishGesture = useCallback((event: GestureResponderEvent) => {
    clearTrackpadDragTimer();
    clearDirectPressTimer();
    const mode = gestureRef.current;
    gestureRef.current = 'none';
    if (mode === 'direct-pending' && lastMappedRef.current) {
      const point = event.nativeEvent.touches[0] ? mapTouchClamped(event.nativeEvent.touches[0]) : lastMappedRef.current;
      const releasePoint = point ?? lastMappedRef.current;
      controllerRef.current?.sendButton(releasePoint.x, releasePoint.y, 0, true);
      controllerRef.current?.sendButton(releasePoint.x, releasePoint.y, 0, false);
    } else if (mode === 'direct' && lastMappedRef.current) {
      const point = event.nativeEvent.touches[0] ? mapTouchClamped(event.nativeEvent.touches[0]) : lastMappedRef.current;
      controllerRef.current?.sendButton((point ?? lastMappedRef.current).x, (point ?? lastMappedRef.current).y, 0, false);
    } else if (mode === 'trackpad' && !trackpadMovedRef.current) {
      if (trackpadDraggingRef.current) finishTrackpadDrag(true);
      else {
        const point = cursorRef.current;
        controllerRef.current?.sendButton(point.x, point.y, 0, true);
        controllerRef.current?.sendButton(point.x, point.y, 0, false);
      }
    } else if (mode === 'trackpad') {
      finishTrackpadDrag(true);
    }
    directPressPointRef.current = undefined;
    multiTouchRef.current = undefined;
    lastTouchRef.current = undefined;
    trackpadMovedRef.current = false;
  }, [clearDirectPressTimer, clearTrackpadDragTimer, controllerRef, finishTrackpadDrag, mapTouchClamped]);

  const onPanResponderGrant = useCallback((event: GestureResponderEvent) => {
    const touches = event.nativeEvent.touches;
    clearWheelPump();
    if (touches.length > 1) {
      beginMultiTouch(touches);
      return;
    }
    if (!inputReadyRef.current) {
      gestureRef.current = 'none';
      showControlHint();
      return;
    }
    const touch = touches[0];
    if (!touch) return;
    const point = mapTouchClamped(touch);
    lastMappedRef.current = point;
    lastTouchRef.current = { x: touch.locationX, y: touch.locationY };
    if (mouseModeRef.current === 'trackpad') {
      gestureRef.current = 'trackpad';
      trackpadMovedRef.current = false;
      trackpadDraggingRef.current = false;
      clearTrackpadDragTimer();
      trackpadDragTimerRef.current = setTimeout(() => {
        trackpadDragTimerRef.current = null;
        if (gestureRef.current !== 'trackpad' || trackpadMovedRef.current || !inputReadyRef.current) return;
        trackpadDraggingRef.current = true;
        setTrackpadDragging(true);
        const cursorPoint = cursorRef.current;
        controllerRef.current?.sendButton(cursorPoint.x, cursorPoint.y, 0, true);
      }, TRACKPAD_DRAG_DELAY_MS);
      return;
    }
    gestureRef.current = 'direct-pending';
    directPressPointRef.current = point;
    if (!point) return;
    controllerRef.current?.sendPointer(point.x, point.y);
    clearDirectPressTimer();
    directPressTimerRef.current = setTimeout(commitDirectPress, DIRECT_PRESS_DELAY_MS);
  }, [beginMultiTouch, clearDirectPressTimer, clearTrackpadDragTimer, clearWheelPump, commitDirectPress, controllerRef, inputReadyRef, mapTouchClamped, mouseModeRef, showControlHint]);

  const onPanResponderMove = useCallback((event: GestureResponderEvent) => {
    const touches = event.nativeEvent.touches;
    if (touches.length > 1) {
      if (gestureRef.current !== 'multi') beginMultiTouch(touches);
      else updateMultiTouch(touches);
      return;
    }
    if (gestureRef.current === 'multi') return;
    if (!inputReadyRef.current) return;
    const touch = touches[0];
    if (!touch) return;
    const point = mapTouchClamped(touch);
    if (!point) return;
    lastMappedRef.current = point;
    if (gestureRef.current === 'trackpad') {
      clearTrackpadDragTimer();
      const currentTouch = { x: touch.locationX, y: touch.locationY };
      const previousTouch = lastTouchRef.current ?? currentTouch;
      lastTouchRef.current = currentTouch;
      const rect = remoteDesktopContainRect(viewportRef.current, contentSizeRef.current);
      const transformedWidth = rect.width * transformRef.current.scale;
      const transformedHeight = rect.height * transformRef.current.scale;
      if (transformedWidth <= 0 || transformedHeight <= 0) return;
      const deltaX = (currentTouch.x - previousTouch.x) / transformedWidth;
      const deltaY = (currentTouch.y - previousTouch.y) / transformedHeight;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 0.0015) trackpadMovedRef.current = true;
      const next = {
        x: clamp01(cursorRef.current.x + deltaX * 1.35),
        y: clamp01(cursorRef.current.y + deltaY * 1.35),
      };
      cursorRef.current = next;
      setCursor(next);
      controllerRef.current?.sendPointer(next.x, next.y);
      return;
    }
    if (gestureRef.current === 'direct-pending') {
      directPressPointRef.current = point;
      const startTouch = lastTouchRef.current;
      const moved = startTouch ? Math.hypot(touch.locationX - startTouch.x, touch.locationY - startTouch.y) : 0;
      if (moved >= DIRECT_MOVE_THRESHOLD) commitDirectPress();
    }
    if (gestureRef.current === 'direct') {
      controllerRef.current?.sendPointer(point.x, point.y);
    }
  }, [beginMultiTouch, clearTrackpadDragTimer, commitDirectPress, controllerRef, contentSizeRef, inputReadyRef, mapTouchClamped, transformRef, updateMultiTouch, viewportRef]);

  const onTouchStart = useCallback((event: GestureResponderEvent) => {
    if (event.nativeEvent.touches.length > 1) beginMultiTouch(event.nativeEvent.touches);
  }, [beginMultiTouch]);

  // PanResponder stores these callbacks; it never invokes them during render.
  // eslint-disable-next-line react-hooks/refs
  const panResponder = createPanResponder(onPanResponderGrant, onPanResponderMove, finishGesture);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const next = { width, height };
    if (next.width !== viewportRef.current.width || next.height !== viewportRef.current.height) {
      viewportRef.current = next;
      setViewport(next);
    }
  };

  useEffect(() => {
    if (inputReady) return;
    clearTrackpadDragTimer();
    clearDirectPressTimer();
    clearWheelPump();
    trackpadDraggingRef.current = false;
    const timer = setTimeout(() => setTrackpadDragging(false), 0);
    return () => clearTimeout(timer);
  }, [clearDirectPressTimer, clearTrackpadDragTimer, clearWheelPump, inputReady]);

  useEffect(() => {
    clearWheelPump();
  }, [clearWheelPump, targetKey]);

  useEffect(() => () => {
    if (controlHintTimerRef.current !== null) clearTimeout(controlHintTimerRef.current);
  }, []);

  useEffect(() => () => {
    clearTrackpadDragTimer();
    clearDirectPressTimer();
    clearWheelPump();
    if (!trackpadDraggingRef.current) return;
    const point = cursorRef.current;
    controllerRef.current?.sendButton(point.x, point.y, 0, false);
    trackpadDraggingRef.current = false;
  }, [clearDirectPressTimer, clearTrackpadDragTimer, clearWheelPump, controllerRef]);

  useEffect(() => {
    if (snapshot.path !== 'websocket') return;
    // The native surface may mount after the first fallback keyframe was
    // requested. Retry after layout so a decoder attached late still paints.
    const timers = [0, 350, 1_100].map((delay) => setTimeout(() => controller?.requestKeyframe(), delay));
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [controller, snapshot.path, snapshot.transportStates.websocket, snapshot.videoHeight, snapshot.videoWidth]);

  const scale = transform.scale;
  const activeControlHint = controlHint === remoteDesktopControlHint(snapshot) ? controlHint : undefined;
  const mediaFrame = contentRect.width > 0 && contentRect.height > 0
    ? {
        height: contentRect.height * scale,
        left: viewport.width / 2 + transform.translateX - contentRect.width * scale / 2,
        position: 'absolute' as const,
        top: viewport.height / 2 + transform.translateY - contentRect.height * scale / 2,
        width: contentRect.width * scale,
      }
    : StyleSheet.absoluteFill;

  return <View onLayout={onLayout} style={styles.root}>
    <View pointerEvents="none" style={[styles.media, mediaFrame]}>
      {snapshot.path === 'websocket' ? <RemoteDesktopSurface style={StyleSheet.absoluteFill} />
        : snapshot.streamURL ? <RTCView
        mirror={false}
        objectFit="contain"
        onDimensionsChange={(event) => {
          const next = { width: event.nativeEvent.width, height: event.nativeEvent.height };
          if (next.width > 0 && next.height > 0 && (next.width !== streamSizeRef.current.width || next.height !== streamSizeRef.current.height)) {
            streamSizeRef.current = next;
            setStreamSize(next);
          }
        }}
        streamURL={snapshot.streamURL}
        style={StyleSheet.absoluteFill}
      /> : null}
      {inputReady && mouseMode === 'trackpad' ? <RemoteDesktopCursor accentColor={colors.primary} dragging={trackpadDragging} point={cursor} /> : null}
    </View>
    <View {...panResponder.panHandlers} onTouchStart={onTouchStart} style={StyleSheet.absoluteFill} />
    {activeControlHint ? <View pointerEvents="box-none" style={styles.controlHintHost}>
      <View accessibilityLiveRegion="polite" style={[styles.controlHint, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Hand color={colors.text} size={18} strokeWidth={1.9} />
        <Text style={[styles.controlHintText, { color: colors.text }]}>{activeControlHint === 'another-viewer' ? t('remoteDesktop.anotherViewerControls') : t('remoteDesktop.controlAvailable')}</Text>
        <Pressable
          accessibilityLabel={t('remoteDesktop.requestControl')}
          accessibilityRole="button"
          disabled={snapshot.controlRequestPending}
          onPress={() => controllerRef.current?.requestControl()}
          style={({ pressed }) => [styles.controlHintAction, pressed && styles.pressed]}
        >
          <Text style={[styles.controlHintActionText, { color: colors.primary }]}>{snapshot.controlRequestPending ? t('remoteDesktop.requestingControl') : t('remoteDesktop.requestControl')}</Text>
        </Pressable>
      </View>
    </View> : null}
    {scale > 1.01 ? <View pointerEvents="none" style={[styles.zoomBadge, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.zoomText, { color: colors.text }]}>{scale.toFixed(1)}×</Text></View> : null}
  </View>;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function createPanResponder(
  onPanResponderGrant: (event: GestureResponderEvent) => void,
  onPanResponderMove: (event: GestureResponderEvent) => void,
  onPanResponderRelease: (event: GestureResponderEvent) => void,
) {
  return PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant,
    onPanResponderMove,
    onPanResponderRelease,
    onPanResponderTerminate: onPanResponderRelease,
  });
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#000', flex: 1, overflow: 'hidden' },
  media: { backgroundColor: '#000', overflow: 'hidden' },
  controlHintHost: { bottom: 104, left: 14, position: 'absolute', right: 14 },
  controlHint: { alignItems: 'center', alignSelf: 'center', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 9, maxWidth: 420, paddingHorizontal: 12, paddingVertical: 9, shadowColor: '#000', shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.25, shadowRadius: 12 },
  controlHintText: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  controlHintAction: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 4 },
  controlHintActionText: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  zoomBadge: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, height: 30, justifyContent: 'center', minWidth: 46, paddingHorizontal: 8, position: 'absolute', right: 14, top: 14 },
  zoomText: { fontSize: 12, fontWeight: '500' },
  pressed: { opacity: 0.58 },
});
