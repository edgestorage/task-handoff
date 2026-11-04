import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
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

type TabLayout = { width: number; x: number };

export type AnimatedTabStripOption<T extends string> = {
  label: string;
  testID?: string;
  value: T;
};

export function AnimatedTabStrip<T extends string>({
  accessibilityLabel,
  indicatorTestID,
  labelStyle,
  onChange,
  optionStyle,
  options,
  scrollTestID,
  style,
  testID,
  value,
}: {
  accessibilityLabel?: string;
  indicatorTestID?: string;
  labelStyle?: StyleProp<TextStyle>;
  onChange(value: T): void;
  optionStyle?: StyleProp<ViewStyle>;
  options: readonly AnimatedTabStripOption<T>[];
  scrollTestID?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  value: T;
}) {
  const { colors } = useMobileTheme();
  const [layouts, setLayouts] = useState<Partial<Record<T, TabLayout>>>({});
  const indicatorX = useSharedValue(0);
  const indicatorWidth = useSharedValue(0);
  const positionedValue = useRef<T | undefined>(undefined);
  const selectedLayout = layouts[value];
  const selectedX = selectedLayout?.x;
  const selectedWidth = selectedLayout?.width;

  useEffect(() => {
    if (selectedX == null || selectedWidth == null) return;
    const previousValue = positionedValue.current;
    const animate = previousValue != null && previousValue !== value;
    positionedValue.current = value;
    const config = {
      duration: INDICATOR_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    };
    if (animate) {
      indicatorX.value = withTiming(selectedX, config);
      indicatorWidth.value = withTiming(selectedWidth, config);
    } else {
      indicatorX.value = selectedX;
      indicatorWidth.value = selectedWidth;
    }
  }, [indicatorWidth, indicatorX, selectedWidth, selectedX, value]);

  const recordLayout = (option: T, event: LayoutChangeEvent) => {
    const { width, x } = event.nativeEvent.layout;
    setLayouts((current) => {
      const previous = current[option];
      if (previous?.x === x && previous.width === width) return current;
      return { ...current, [option]: { width, x } };
    });
  };

  const indicatorStyle = useAnimatedStyle(() => ({
    opacity: indicatorWidth.value > 0 ? 1 : 0,
    transform: [{ translateX: indicatorX.value }],
    width: indicatorWidth.value,
  }));

  return <View
    accessibilityLabel={accessibilityLabel}
    accessibilityRole="tablist"
    style={[styles.track, { backgroundColor: colors.workbenchSelectionBackground }, style]}
    testID={testID}
  >
    <ScrollView
      bounces={false}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="never"
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      testID={scrollTestID}
    >
      <View style={styles.row}>
        {options.length ? <Animated.View
          pointerEvents="none"
          style={[styles.indicator, { backgroundColor: colors.statusFilterSelectedBackground }, indicatorStyle]}
          testID={indicatorTestID}
        /> : null}
        {options.map((option) => {
          const selected = option.value === value;
          return <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={option.value}
            onLayout={(event) => recordLayout(option.value, event)}
            onPress={() => onChange(option.value)}
            style={[styles.option, optionStyle]}
            testID={option.testID}
          >
            <Text numberOfLines={1} style={[styles.label, { color: selected ? colors.text : colors.textMuted }, labelStyle]}>{option.label}</Text>
          </Pressable>;
        })}
      </View>
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  track: { borderRadius: 999, overflow: 'hidden', width: '100%' },
  scrollContent: { flexGrow: 1, padding: INDICATOR_INSET },
  row: { flexDirection: 'row', flexGrow: 1, minWidth: '100%', position: 'relative' },
  indicator: {
    borderRadius: 999,
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
  },
  option: { alignItems: 'center', borderRadius: 999, flexGrow: 1, flexShrink: 0, justifyContent: 'center', minHeight: 34, minWidth: 44, paddingHorizontal: 5, zIndex: 1 },
  label: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
});
