import { useLayoutEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react-native';
import { PanResponder, StyleSheet, View } from 'react-native';

import { mobileWebMetric } from './mobile-web-typography';
import { useMobileTheme } from './theme';

export function ReorderDragHandle({
  disabled,
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
  const callbacks = useRef({ onDragCancel, onDragEnd, onDragMove, onDragStart });
  const disabledRef = useRef(disabled);
  useLayoutEffect(() => {
    callbacks.current = { onDragCancel, onDragEnd, onDragMove, onDragStart };
    disabledRef.current = disabled;
  }, [disabled, onDragCancel, onDragEnd, onDragMove, onDragStart]);
  // PanResponder retains these functions for native events; refs keep their inputs current.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: () => !disabledRef.current,
    onMoveShouldSetPanResponder: () => !disabledRef.current,
    onPanResponderGrant: () => callbacks.current.onDragStart(),
    onPanResponderMove: (_event, gesture) => callbacks.current.onDragMove(gesture.dy),
    onPanResponderRelease: () => callbacks.current.onDragEnd(),
    onPanResponderTerminate: () => callbacks.current.onDragCancel(),
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onStartShouldSetPanResponderCapture: () => !disabledRef.current,
    onStartShouldSetPanResponder: () => !disabledRef.current,
  }));
  return <View
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
    {...responder.panHandlers}
  ><GripVertical color={colors.textMuted} size={mobileWebMetric(17)} strokeWidth={1.8} /></View>;
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.4 },
  handle: { alignItems: 'center', height: 40, justifyContent: 'center', width: 24 },
});
