import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import Animated, {
  Easing,
  interpolate,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

const DISCLOSURE_EXPAND_DURATION_MS = 220;
const DISCLOSURE_COLLAPSE_DURATION_MS = 180;

export function AnimatedDisclosure({
  animateContent = true,
  children,
  contentRevealDelay = 0,
  expanded,
  expandDuration = DISCLOSURE_EXPAND_DURATION_MS,
  onContentMeasured,
  onSettled,
  reserveExpandedHeight = false,
  spacing = 0,
  testID,
}: {
  /** Disable content motion while retaining the disclosure animation. */
  animateContent?: boolean;
  children: ReactNode;
  /** Delay before content motion begins when opening. */
  contentRevealDelay?: number;
  expanded: boolean;
  /** Duration of the opening motion; collapse keeps its shorter duration. */
  expandDuration?: number;
  onContentMeasured?(height: number): void;
  onSettled?(expanded: boolean): void;
  /** Reserve the measured height immediately when opening, then animate the rest around it. */
  reserveExpandedHeight?: boolean;
  spacing?: number;
  testID?: string;
}) {
  const [contentVisible, setContentVisible] = useState(expanded);
  const progress = useSharedValue(expanded ? 1 : 0);
  const layoutProgress = useSharedValue(expanded ? 1 : 0);
  const contentHeight = useSharedValue(0);
  const handleSettled = useCallback((next: boolean) => {
    if (!next) setContentVisible(false);
    onSettled?.(next);
  }, [onSettled]);
  if (expanded && !contentVisible) setContentVisible(true);

  useEffect(() => {
    const duration = expanded ? expandDuration : DISCLOSURE_COLLAPSE_DURATION_MS;
    const easing = expanded ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic);
    const reveal = withTiming(expanded ? 1 : 0, {
      duration,
      easing,
      reduceMotion: ReduceMotion.System,
    }, (finished) => {
      if (finished) runOnJS(handleSettled)(expanded);
    });
    progress.value = expanded && contentRevealDelay > 0
      ? withDelay(contentRevealDelay, reveal)
      : reveal;
    if (reserveExpandedHeight && expanded) {
      layoutProgress.value = 1;
      return;
    }
    layoutProgress.value = withTiming(expanded ? 1 : 0, {
      duration,
      easing,
      reduceMotion: ReduceMotion.System,
    });
  }, [contentRevealDelay, expandDuration, expanded, handleSettled, layoutProgress, progress, reserveExpandedHeight]);

  const animatedStyle = useAnimatedStyle(() => animateContent ? ({
    height: contentHeight.value * layoutProgress.value,
    opacity: interpolate(progress.value, [0, 0.18, 1], [0, 0.88, 1]),
    transform: [{ translateY: interpolate(progress.value, [0, 1], [-4, 0]) }],
  }) : ({ height: contentHeight.value * layoutProgress.value }));

  if (!contentVisible) return null;
  return <Animated.View
    accessibilityElementsHidden={!expanded}
    importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
    pointerEvents={expanded ? 'auto' : 'none'}
    style={[styles.clip, animatedStyle]}
    testID={testID}
  >
    <View
      collapsable={false}
      onLayout={(event) => {
        const height = event.nativeEvent.layout.height;
        contentHeight.value = height;
        if (expanded) onContentMeasured?.(height);
      }}
      style={[styles.measure, spacing ? { paddingTop: spacing } : undefined]}
      testID={testID ? `${testID}-content` : undefined}
    >
      {children}
    </View>
  </Animated.View>;
}

export function DisclosureChevron({
  color,
  expanded,
  size,
  style,
}: {
  color: string;
  expanded: boolean;
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  const rotation = useSharedValue(expanded ? 1 : 0);

  useEffect(() => {
    rotation.value = withTiming(expanded ? 1 : 0, {
      duration: expanded ? DISCLOSURE_EXPAND_DURATION_MS : DISCLOSURE_COLLAPSE_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [expanded, rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 90}deg` }],
  }));
  return <Animated.View style={[style, animatedStyle]}>
    <ChevronRight color={color} size={size} />
  </Animated.View>;
}

export function DisclosureChevronDown({
  color,
  expanded,
  size,
  style,
}: {
  color: string;
  expanded: boolean;
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  const rotation = useSharedValue(expanded ? 0 : -90);

  useEffect(() => {
    rotation.value = withTiming(expanded ? 0 : -90, {
      duration: expanded ? DISCLOSURE_EXPAND_DURATION_MS : DISCLOSURE_COLLAPSE_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [expanded, rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  return <Animated.View style={[style, animatedStyle]}>
    <ChevronDown color={color} size={size} />
  </Animated.View>;
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  measure: { left: 0, position: 'absolute', right: 0, top: 0 },
});
