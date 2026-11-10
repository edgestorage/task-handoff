import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent, type NativeTouchEvent } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import Svg, { Path } from 'react-native-svg';

import RemoteDesktopSurface from '../../modules/task-handoff-remote-desktop/src/RemoteDesktopSurface';
import { useMobileTheme } from '../components/theme';
import type { RemoteDesktopController } from './controller';
import {
  IDENTITY_REMOTE_DESKTOP_TRANSFORM,
  constrainRemoteDesktopTransform,
  remoteDesktopContainRect,
  remoteDesktopPinchTransform,
  remoteDesktopMultiTouchIntent,
  remoteDesktopPointForTouch,
  remoteDesktopTouchDistance,
  remoteDesktopTouchMidpoint,
  type RemoteDesktopPoint,
  type RemoteDesktopSize,
  type RemoteDesktopTransform,
} from './geometry';
import type { RemoteDesktopMouseMode } from './preferences';
import type { RemoteDesktopSnapshot } from './types';
import { useLatestRef } from './use-latest-ref';

const TRACKPAD_DRAG_DELAY_MS = 420;

type Props = {
  controller?: RemoteDesktopController;
  mouseMode: RemoteDesktopMouseMode;
  snapshot: RemoteDesktopSnapshot;
};

type GestureMode = 'none' | 'direct' | 'trackpad' | 'multi';
type ZoomState = { targetKey: string; transform: RemoteDesktopTransform };

export function RemoteDesktopTouchSurface({ controller, mouseMode, snapshot }: Props) {
  const { colors } = useMobileTheme();
  const [viewport, setViewport] = useState<RemoteDesktopSize>({ width: 0, height: 0 });
  const [streamSize, setStreamSize] = useState<RemoteDesktopSize>({ width: 0, height: 0 });
  const targetKey = snapshot.target.kind === 'window' ? `window:${snapshot.target.windowRef}` : 'display';
  const [zoom, setZoom] = useState<ZoomState>({ targetKey, transform: IDENTITY_REMOTE_DESKTOP_TRANSFORM });
  const [cursor, setCursor] = useState<RemoteDesktopPoint>({ x: 0.5, y: 0.5 });
  const cursorRef = useRef(cursor);
  const controllerRef = useLatestRef(controller);
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
  const [trackpadDragging, setTrackpadDragging] = useState(false);
  const multiTouchRef = useRef<{
    start: RemoteDesktopTransform;
    startMidpoint: RemoteDesktopPoint;
    startDistance: number;
    lastMidpoint: RemoteDesktopPoint;
    intent: 'pending' | 'scroll' | 'pinch';
  } | undefined>(undefined);

  const inputReady = snapshot.inputEnabled && snapshot.isController && !snapshot.paused;
  const inputReadyRef = useLatestRef(inputReady);
  const contentRect = remoteDesktopContainRect(viewport, contentSize);
  const transform = zoom.targetKey === targetKey
    ? constrainRemoteDesktopTransform(zoom.transform, viewport, contentRect)
    : IDENTITY_REMOTE_DESKTOP_TRANSFORM;
  const transformRef = useLatestRef(transform);

  const mapViewportPoint = useCallback((point: RemoteDesktopPoint) => remoteDesktopPointForTouch(
    point,
    viewportRef.current,
    contentSizeRef.current,
    transformRef.current,
  ), [contentSizeRef, transformRef, viewportRef]);

  const mapTouch = useCallback((touch: NativeTouchEvent) => mapViewportPoint({
    x: touch.locationX,
    y: touch.locationY,
  }), [mapViewportPoint]);

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
    if (gestureRef.current === 'direct' && lastMappedRef.current) {
      controllerRef.current?.sendButton(lastMappedRef.current.x, lastMappedRef.current.y, 0, false);
    }
    finishTrackpadDrag(true);
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
      lastMidpoint: midpoint,
      intent: 'pending',
    };
  }, [controllerRef, finishTrackpadDrag, transformRef]);

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
      const previous = mapViewportPoint(multiTouch.lastMidpoint);
      const current = mapViewportPoint(midpoint);
      if (previous && current) {
        const deltaX = (previous.x - current.x) * 2_000;
        const deltaY = (previous.y - current.y) * 2_000;
        if (Math.abs(deltaX) + Math.abs(deltaY) >= 1) controllerRef.current?.sendWheel(current.x, current.y, deltaX, deltaY);
      }
    }
    multiTouch.lastMidpoint = midpoint;
  }, [contentSizeRef, controllerRef, mapViewportPoint, updateTransform, viewportRef]);

  const finishGesture = useCallback((event: GestureResponderEvent) => {
    clearTrackpadDragTimer();
    const mode = gestureRef.current;
    gestureRef.current = 'none';
    if (mode === 'direct' && lastMappedRef.current) {
      const point = event.nativeEvent.touches[0] ? mapTouch(event.nativeEvent.touches[0]) : lastMappedRef.current;
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
    multiTouchRef.current = undefined;
    lastTouchRef.current = undefined;
    trackpadMovedRef.current = false;
  }, [clearTrackpadDragTimer, controllerRef, finishTrackpadDrag, mapTouch]);

  const onPanResponderGrant = useCallback((event: GestureResponderEvent) => {
    const touches = event.nativeEvent.touches;
    if (touches.length > 1) {
      beginMultiTouch(touches);
      return;
    }
    if (!inputReadyRef.current) {
      gestureRef.current = 'none';
      return;
    }
    const touch = touches[0];
    const point = touch ? mapTouch(touch) : undefined;
    if (!point) {
      gestureRef.current = 'none';
      return;
    }
    lastMappedRef.current = point;
    lastTouchRef.current = point;
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
    gestureRef.current = 'direct';
    controllerRef.current?.sendPointer(point.x, point.y);
    controllerRef.current?.sendButton(point.x, point.y, 0, true);
  }, [beginMultiTouch, clearTrackpadDragTimer, controllerRef, inputReadyRef, mapTouch, mouseModeRef]);

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
    const point = touch ? mapTouch(touch) : undefined;
    if (!point) return;
    lastMappedRef.current = point;
    if (gestureRef.current === 'trackpad') {
      clearTrackpadDragTimer();
      const deltaX = point.x - (lastTouchRef.current?.x ?? point.x);
      const deltaY = point.y - (lastTouchRef.current?.y ?? point.y);
      lastTouchRef.current = point;
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
    if (gestureRef.current === 'direct') {
      lastTouchRef.current = point;
      controllerRef.current?.sendPointer(point.x, point.y);
    }
  }, [beginMultiTouch, clearTrackpadDragTimer, controllerRef, inputReadyRef, mapTouch, updateMultiTouch]);

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
    trackpadDraggingRef.current = false;
    const timer = setTimeout(() => setTrackpadDragging(false), 0);
    return () => clearTimeout(timer);
  }, [clearTrackpadDragTimer, inputReady]);

  useEffect(() => () => {
    clearTrackpadDragTimer();
    if (!trackpadDraggingRef.current) return;
    const point = cursorRef.current;
    controllerRef.current?.sendButton(point.x, point.y, 0, false);
    trackpadDraggingRef.current = false;
  }, [clearTrackpadDragTimer, controllerRef]);

  useEffect(() => {
    if (snapshot.path !== 'websocket') return;
    // The native surface may mount after the first fallback keyframe was
    // requested. Retry after layout so a decoder attached late still paints.
    const timers = [0, 350, 1_100].map((delay) => setTimeout(() => controller?.requestKeyframe(), delay));
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [controller, snapshot.path, snapshot.transportStates.websocket, snapshot.videoHeight, snapshot.videoWidth]);

  const scale = transform.scale;
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
    <View {...panResponder.panHandlers} style={StyleSheet.absoluteFill} />
    {scale > 1.01 ? <View pointerEvents="none" style={[styles.zoomBadge, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.zoomText, { color: colors.text }]}>{scale.toFixed(1)}×</Text></View> : null}
  </View>;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

const CURSOR_PATH = 'M1.5 1.5 L1.5 22.6 L6.9 17.4 L10.5 26.2 C10.75 26.85 11.45 27.15 12.1 26.9 L14.6 25.85 C15.2 25.6 15.5 24.95 15.25 24.35 L11.8 15.65 L19 15.15 C19.75 15.1 20.1 14.2 19.55 13.65 Z';

function RemoteDesktopCursor({ accentColor, dragging, point }: { accentColor: string; dragging: boolean; point: RemoteDesktopPoint }) {
  return <View pointerEvents="none" style={[styles.cursor, { left: `${point.x * 100}%`, top: `${point.y * 100}%` }]}>
    <Svg height={32} viewBox="0 0 24 30" width={26}>
      <Path d={CURSOR_PATH} fill="rgba(0,0,0,0.3)" transform="translate(1 1.5)" />
      <Path d={CURSOR_PATH} fill={dragging ? accentColor : '#ffffff'} stroke={dragging ? '#1f5fae' : 'rgba(15,23,42,0.9)'} strokeLinejoin="round" strokeWidth={1.6} />
    </Svg>
  </View>;
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
  cursor: { height: 32, marginLeft: -2, marginTop: -2, position: 'absolute', width: 26 },
  zoomBadge: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, height: 30, justifyContent: 'center', minWidth: 46, paddingHorizontal: 8, position: 'absolute', right: 14, top: 14 },
  zoomText: { fontSize: 12, fontWeight: '500' },
});
