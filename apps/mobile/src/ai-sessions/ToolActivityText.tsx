import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';

import { useMobileTheme } from '../components/theme';

// React Native layout measurements are density-independent logical units
// (points on iOS and dp on Android), rather than physical screen pixels.
const SWEEP_WIDTH = 72;
const SWEEP_SPEED_UNITS_PER_SECOND = 100;
const SWEEP_PAUSE_MS = 1_500;
const STRIPE_OPACITIES = [0.08, 0.18, 0.38, 0.68, 1, 0.68, 0.38, 0.18, 0.08];
const STRIPE_WIDTH = SWEEP_WIDTH / STRIPE_OPACITIES.length;

export function ToolActivityText({
  children,
  containerStyle,
  numberOfLines = 1,
  running,
  textStyle,
}: {
  children: string;
  containerStyle?: StyleProp<ViewStyle>;
  numberOfLines?: number;
  running: boolean;
  textStyle?: StyleProp<TextStyle>;
}) {
  const { colors } = useMobileTheme();
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [sweep] = useState(() => new Animated.Value(-SWEEP_WIDTH));

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted && enabled) setReduceMotion(true);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    sweep.stopAnimation();
    if (!running || reduceMotion || textWidth <= 0) return;
    const sweepDuration = ((textWidth + SWEEP_WIDTH * 2) / SWEEP_SPEED_UNITS_PER_SECOND) * 1_000;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(sweep, {
        duration: sweepDuration,
        easing: (value) => value,
        isInteraction: false,
        toValue: textWidth + SWEEP_WIDTH,
        useNativeDriver: true,
      }),
      Animated.delay(SWEEP_PAUSE_MS),
    ]));
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, running, sweep, textWidth]);

  const inverseSweep = Animated.multiply(sweep, -1);
  return (
    <View
      accessibilityLabel={children}
      onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}
      style={[styles.container, containerStyle]}
      testID="tool-activity-text"
    >
      <Text
        numberOfLines={numberOfLines}
        onLayout={(event) => setTextWidth(event.nativeEvent.layout.width)}
        style={[textStyle, styles.baseText, { color: colors.textMuted }]}
        testID="tool-activity-label"
      >
        {children}
      </Text>
      {running && !reduceMotion && containerWidth > 0 && textWidth > 0 ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={styles.overlay}>
          {STRIPE_OPACITIES.map((opacity, index) => {
            const offset = index * STRIPE_WIDTH;
            return (
              <Animated.View
                key={offset}
                style={[styles.stripe, {
                  left: offset,
                  opacity,
                  transform: [{ translateX: sweep }],
                  width: STRIPE_WIDTH + StyleSheet.hairlineWidth,
                }]}
              >
                <Animated.Text
                  numberOfLines={numberOfLines}
                  style={[textStyle, styles.highlightText, {
                    color: colors.text,
                    left: -offset,
                    transform: [{ translateX: inverseSweep }],
                    width: containerWidth,
                  }]}
                >
                  {children}
                </Animated.Text>
              </Animated.View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { minWidth: 0, overflow: 'hidden' },
  baseText: { alignSelf: 'flex-start', maxWidth: '100%' },
  overlay: { bottom: 0, left: 0, overflow: 'hidden', position: 'absolute', right: 0, top: 0 },
  stripe: { bottom: 0, overflow: 'hidden', position: 'absolute', top: 0 },
  highlightText: { position: 'absolute', top: 0 },
});
