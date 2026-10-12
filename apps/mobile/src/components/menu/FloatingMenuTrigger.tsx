import { cloneElement, Fragment, isValidElement, useCallback, useImperativeHandle, useRef, useState, type ReactElement, type Ref } from 'react';
import { View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';

import { FloatingMenu, type FloatingMenuAnchor } from './FloatingMenu';
import type { FloatingMenuPage } from './menu-model';

/** Matches React Native's default long-press delay so context menus feel native. */
const LONG_PRESS_DELAY = 420;
/** A touch that travels further than this is a scroll, not a tap. */
const MOVE_TOLERANCE = 10;

export type FloatingMenuTriggerHandle = { show(): void };

type LongPressTriggerProps = { delayLongPress?: number; onLongPress?(event: GestureResponderEvent): void };

type FloatingMenuTriggerProps = {
  page?: FloatingMenuPage | null;
  disabled?: boolean;
  /**
   * `false`: any tap on the wrapped view opens the menu.
   * `true`: long-press opens the menu, and the trigger element keeps its own tap
   * handler. The long-press handler is injected into the trigger element itself so
   * React Native cancels its tap afterwards (a wrapper handler cannot do that).
   */
  longPress?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  ref?: Ref<FloatingMenuTriggerHandle>;
  onOpen?(): void;
  onClose?(): void;
  children(open: () => void): ReactElement;
};

/**
 * Wraps a trigger view and shows `FloatingMenu` anchored to it. Taps are observed
 * through the wrapper's touch events instead of the responder system so a `Pressable`
 * inside the trigger keeps working (RN's `Pressable` always claims the responder, which
 * is what made nested menu triggers unresponsive).
 */
export function FloatingMenuTrigger({ children, disabled, longPress = false, onClose, onOpen, page, ref, style, testID }: FloatingMenuTriggerProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const [node, setNode] = useState<View | null>(null);
  const [anchor, setAnchor] = useState<FloatingMenuAnchor | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const present = useCallback((point?: { x: number; y: number }) => {
    if (disabled || !page || !node) return;
    node.measureInWindow((x, y, width, height) => {
      setAnchor((current) => current ?? { height, point, width, x, y });
      onOpen?.();
    });
  }, [disabled, node, onOpen, page]);

  const dismiss = useCallback(() => {
    clearTimer();
    setAnchor(null);
    onClose?.();
  }, [clearTimer, onClose]);

  useImperativeHandle(ref, () => ({ show: () => present() }), [present]);

  const handleLongPress = useCallback((event: GestureResponderEvent) => {
    present({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });
  }, [present]);
  const element = children(() => present());
  const injectLongPress = longPress === true && isValidElement(element) && element.type !== Fragment;
  const trigger = injectLongPress
    ? cloneElement(element as ReactElement<LongPressTriggerProps>, { delayLongPress: LONG_PRESS_DELAY, onLongPress: handleLongPress })
    : element;

  const handleTouchStart = useCallback((event: GestureResponderEvent) => {
    start.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
    moved.current = false;
    if (!longPress) return;
    clearTimer();
    const point = start.current;
    timer.current = setTimeout(() => { timer.current = null; present(point); }, LONG_PRESS_DELAY);
  }, [clearTimer, longPress, present]);

  const handleTouchMove = useCallback((event: GestureResponderEvent) => {
    if (moved.current || !start.current) return;
    const { pageX, pageY } = event.nativeEvent;
    if (Math.abs(pageX - start.current.x) <= MOVE_TOLERANCE && Math.abs(pageY - start.current.y) <= MOVE_TOLERANCE) return;
    moved.current = true;
    clearTimer();
  }, [clearTimer]);

  const handleTouchEnd = useCallback(() => {
    const tap = !longPress && start.current !== null && !moved.current;
    clearTimer();
    if (tap) present();
    start.current = null;
  }, [clearTimer, longPress, present]);

  const handleTouchCancel = useCallback(() => {
    start.current = null;
    clearTimer();
  }, [clearTimer]);

  return <>
    <View
      collapsable={false}
      onTouchCancel={injectLongPress ? undefined : handleTouchCancel}
      onTouchEnd={injectLongPress ? undefined : handleTouchEnd}
      onTouchMove={injectLongPress ? undefined : handleTouchMove}
      onTouchStart={injectLongPress ? undefined : handleTouchStart}
      ref={setNode}
      style={style}
      testID={testID}
    >{trigger}</View>
    {anchor && page ? <FloatingMenu anchor={anchor} onDismiss={dismiss} page={page} /> : null}
  </>;
}
