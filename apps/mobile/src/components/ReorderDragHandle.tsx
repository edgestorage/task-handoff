/* eslint-disable react-hooks/refs -- Gesture callbacks need the latest JS handlers without rebuilding an active gesture. */
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { GripVertical } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { mobileWebMetric } from './mobile-web-typography';
import { useMobileTheme } from './theme';

export function ReorderDragHandle({
  disabled,
  dragTranslationY,
  label,
  moveDownLabel,
  moveUpLabel,
  onDragCancel,
  onDragEnd,
  onDragMove,
  onDragStart,
  onMoveDown,
  onMoveUp,
  testID = 'reorder-drag-handle',
}: {
  disabled?: boolean;
  dragTranslationY?: SharedValue<number>;
  label: string;
  moveDownLabel: string;
  moveUpLabel: string;
  onDragCancel(): void;
  onDragEnd(): void;
  onDragMove(dy: number): void;
  onDragStart(): void;
  onMoveDown(): void;
  onMoveUp(): void;
  testID?: string;
}) {
  const { colors } = useMobileTheme();
  const fallbackDragTranslationY = useSharedValue(0);
  const translationY = dragTranslationY ?? fallbackDragTranslationY;
  const callbacks = useRef({ onDragCancel, onDragEnd, onDragMove, onDragStart });
  useLayoutEffect(() => {
    callbacks.current = { onDragCancel, onDragEnd, onDragMove, onDragStart };
  }, [onDragCancel, onDragEnd, onDragMove, onDragStart]);
  const emitDragCancel = useCallback(() => callbacks.current.onDragCancel(), []);
  const emitDragEnd = useCallback(() => callbacks.current.onDragEnd(), []);
  const emitDragMove = useCallback((dy: number) => callbacks.current.onDragMove(dy), []);
  const emitDragStart = useCallback(() => callbacks.current.onDragStart(), []);
  const gesture = useMemo(() => Gesture.Pan()
    .enabled(!disabled)
    .minDistance(1)
    .onStart(() => {
      translationY.set(0);
      scheduleOnRN(emitDragStart);
    })
    .onUpdate((event) => {
      translationY.set(event.translationY);
      scheduleOnRN(emitDragMove, event.translationY);
    })
    .onEnd((_event, success) => {
      if (success) scheduleOnRN(emitDragEnd);
    })
    .onFinalize((_event, success) => {
      if (!success) scheduleOnRN(emitDragCancel);
    }), [disabled, emitDragCancel, emitDragEnd, emitDragMove, emitDragStart, translationY]);
  return <GestureDetector gesture={gesture}><View
    accessibilityActions={[{ name: 'decrement', label: moveUpLabel }, { name: 'increment', label: moveDownLabel }]}
    accessibilityLabel={label}
    accessibilityRole="adjustable"
    accessibilityState={{ disabled: Boolean(disabled) }}
    onAccessibilityAction={(event) => {
      if (disabled) return;
      if (event.nativeEvent.actionName === 'decrement') onMoveUp();
      if (event.nativeEvent.actionName === 'increment') onMoveDown();
    }}
    style={[styles.handle, disabled && styles.disabled]}
    testID={testID}
  ><GripVertical color={colors.textMuted} size={mobileWebMetric(17)} strokeWidth={1.8} /></View></GestureDetector>;
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.4 },
  handle: { alignItems: 'center', height: 40, justifyContent: 'center', width: 24 },
});
