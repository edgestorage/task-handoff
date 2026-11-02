import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import Animated, {
  Easing,
  interpolate,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const DISCLOSURE_EXPAND_DURATION_MS = 220;
const DISCLOSURE_COLLAPSE_DURATION_MS = 180;

export function AnimatedDisclosure({
  children,
  expanded,
  spacing = 0,
  testID,
}: {
  children: ReactNode;
  expanded: boolean;
  spacing?: number;
  testID?: string;
}) {
  const [contentVisible, setContentVisible] = useState(expanded);
  const progress = useSharedValue(expanded ? 1 : 0);
  const contentHeight = useSharedValue(0);
  if (expanded && !contentVisible) setContentVisible(true);

  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, {
      duration: expanded ? DISCLOSURE_EXPAND_DURATION_MS : DISCLOSURE_COLLAPSE_DURATION_MS,
      easing: expanded ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    }, (finished) => {
      if (finished && !expanded) runOnJS(setContentVisible)(false);
    });
  }, [expanded, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: contentHeight.value * progress.value,
    opacity: interpolate(progress.value, [0, 0.18, 1], [0, 0.88, 1]),
    transform: [{ translateY: interpolate(progress.value, [0, 1], [-4, 0]) }],
  }));

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
      onLayout={(event) => { contentHeight.value = event.nativeEvent.layout.height; }}
      style={[styles.measure, spacing ? { paddingTop: spacing } : undefined]}
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

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  measure: { left: 0, position: 'absolute', right: 0, top: 0 },
});
