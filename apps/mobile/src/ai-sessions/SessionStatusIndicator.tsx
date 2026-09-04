import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import type { AiSessionStatusGroup } from '@task-handoff/control-plane-client';

import { useMobileTheme, type MobileThemeColors } from '../components/theme';

export function sessionStatusTone(group: AiSessionStatusGroup, colors: MobileThemeColors) {
  if (group === 'active') return { foreground: colors.sessionActive, background: colors.sessionActiveSoft };
  if (group === 'waiting') return { foreground: colors.sessionWaiting, background: colors.sessionWaitingSoft };
  if (group === 'problem') return { foreground: colors.error, background: colors.errorSoft };
  return { foreground: colors.sessionIdle, background: colors.sessionIdleSoft };
}

export function SessionStatusIndicator({ group, label, size = 14 }: { group: AiSessionStatusGroup; label: string; size?: number }) {
  const { colors } = useMobileTheme();
  const tone = sessionStatusTone(group, colors);
  return (
    <View accessibilityLabel={label} style={[styles.container, { height: size, width: size }]}>
      {group === 'active'
        ? <RunningSpinner background={tone.background} foreground={tone.foreground} size={size} />
        : <View style={[styles.halo, { backgroundColor: tone.background, borderRadius: size / 2, height: size, width: size }]} testID="session-status-dot"><View style={[styles.dot, { backgroundColor: tone.foreground, height: Math.max(6, size - 6), width: Math.max(6, size - 6) }]} /></View>}
    </View>
  );
}

function RunningSpinner({ background, foreground, size }: { background: string; foreground: string; size: number }) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [rotation] = useState(() => new Animated.Value(0));

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let animation: Animated.CompositeAnimation | undefined;
    let live = true;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    const spin = () => {
      rotation.setValue(0);
      animation = Animated.timing(rotation, {
        duration: 1_600,
        easing: Easing.linear,
        isInteraction: false,
        toValue: 1,
        useNativeDriver: true,
      });
      animation.start(({ finished }) => {
        if (finished && live) restartTimer = setTimeout(spin, 0);
      });
    };

    rotation.stopAnimation();
    rotation.setValue(0);
    if (reduceMotion) return;
    spin();
    return () => {
      live = false;
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      animation?.stop();
    };
  }, [reduceMotion, rotation]);

  return (
    <View style={[styles.spinnerTrack, { borderColor: background, borderRadius: (size - 2) / 2, height: size - 2, width: size - 2 }]} testID="session-status-spinner">
      <Animated.View testID="session-status-spinner-arc" style={[styles.spinnerArc, {
        borderBottomColor: foreground,
        borderLeftColor: foreground,
        borderRightColor: foreground,
        borderTopColor: 'transparent',
        borderRadius: size / 2,
        transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
      }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', height: 14, justifyContent: 'center', width: 14 },
  halo: { alignItems: 'center', justifyContent: 'center' },
  dot: { borderRadius: 999 },
  spinnerArc: { borderWidth: 1.5, bottom: -1.5, left: -1.5, position: 'absolute', right: -1.5, top: -1.5 },
  spinnerTrack: { borderWidth: 1.5, position: 'relative' },
});
