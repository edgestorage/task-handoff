import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useMobileTheme } from './theme';

const INDICATOR_INSET = 3;
const INDICATOR_DURATION_MS = 180;

export type AnimatedSegmentedControlOption<T extends string> = {
  label: string;
  testID?: string;
  value: T;
};

export function AnimatedSegmentedControl<T extends string>({
  accessibilityLabel,
  animateFrom,
  labelStyle,
  onChange,
  options,
  style,
  testID,
  value,
}: {
  accessibilityLabel?: string;
  animateFrom?: T;
  labelStyle?: StyleProp<TextStyle>;
  onChange(value: T): void;
  options: readonly AnimatedSegmentedControlOption<T>[];
  style?: StyleProp<ViewStyle>;
  testID?: string;
  value: T;
}) {
  const { colors } = useMobileTheme();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const initialIndex = Math.max(0, options.findIndex((option) => option.value === (animateFrom ?? value)));
  const position = useSharedValue(initialIndex);
  const trackWidth = useSharedValue(0);
  const [trackReady, setTrackReady] = useState(false);
  const segmentCount = Math.max(1, options.length);

  useEffect(() => {
    if (!trackReady) return;
    position.value = withTiming(selectedIndex, {
      duration: INDICATOR_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [position, selectedIndex, trackReady]);

  const indicatorStyle = useAnimatedStyle(() => {
    const segmentWidth = Math.max(0, (trackWidth.value - INDICATOR_INSET * 2) / segmentCount);
    return {
      opacity: trackWidth.value > 0 ? 1 : 0,
      transform: [{ translateX: segmentWidth * position.value }],
      width: segmentWidth,
    };
  });

  return <View
    accessibilityLabel={accessibilityLabel}
    accessibilityRole="tablist"
    onLayout={(event) => {
      trackWidth.value = event.nativeEvent.layout.width;
      if (!trackReady) setTrackReady(true);
    }}
    style={[styles.track, { backgroundColor: colors.workbenchSelectionBackground }, style]}
    testID={testID}
  >
    {options.length ? <Animated.View
      pointerEvents="none"
      style={[styles.indicator, { backgroundColor: colors.surface }, indicatorStyle]}
    /> : null}
    {options.map((option) => {
      const selected = option.value === value;
      return <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        key={option.value}
        onPress={() => onChange(option.value)}
        style={styles.segment}
        testID={option.testID}
      >
        <Text numberOfLines={1} style={[styles.label, { color: selected ? colors.text : colors.textMuted }, labelStyle]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  track: { borderRadius: 999, flexDirection: 'row', padding: INDICATOR_INSET, position: 'relative' },
  indicator: {
    borderRadius: 999,
    bottom: INDICATOR_INSET,
    left: INDICATOR_INSET,
    position: 'absolute',
    shadowColor: '#000',
    shadowOffset: { height: 1, width: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    top: INDICATOR_INSET,
  },
  segment: { alignItems: 'center', borderRadius: 999, flex: 1, justifyContent: 'center', minHeight: 34, paddingHorizontal: 6, zIndex: 1 },
  label: { fontSize: 14, fontWeight: '500', lineHeight: 20 },
});
