import { useEffect, useId, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { SAFE_MARKDOWN_BODY_LINE_HEIGHT } from '../components/SafeMarkdown';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { DisclosureChevron } from './AnimatedDisclosure';

/** Measure the full Markdown, keeping its links and block formatting intact. */
export function CollapsibleUserMessage({ children }: { children: ReactNode }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { fontScale } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const gradientId = useId();
  const progress = useSharedValue(0);
  const collapsedHeight = SAFE_MARKDOWN_BODY_LINE_HEIGHT * fontScale * 4;
  const overflowing = contentHeight > collapsedHeight + 1;

  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, {
      duration: expanded ? 220 : 180,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [expanded, progress]);

  const viewportStyle = useAnimatedStyle(() => ({
    maxHeight: collapsedHeight + Math.max(0, contentHeight - collapsedHeight) * progress.value,
  }));
  const fadeStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));

  // Keep the toggle directly inside the padded bubble so its hitSlop can use
  // that padding instead of being clipped by an extra wrapper's bounds.
  return <>
    <Animated.View style={[styles.viewport, viewportStyle]} testID="user-message-viewport">
      <View onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)} style={styles.content} testID="user-message-full-content">
        {children}
      </View>
      {overflowing ? <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[styles.fade, { height: SAFE_MARKDOWN_BODY_LINE_HEIGHT * fontScale * 1.25 }, fadeStyle]}
        testID="user-message-fade"
      >
        <Svg height="100%" width="100%">
          <Defs>
            <LinearGradient id={gradientId} x1="0" x2="0" y1="0" y2="100%">
              <Stop offset={0} stopColor={colors.workbenchSelectionBackground} stopOpacity={0} />
              <Stop offset={1} stopColor={colors.workbenchSelectionBackground} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect fill={`url(#${gradientId})`} height="100%" width="100%" />
        </Svg>
      </Animated.View> : null}
    </Animated.View>
    {overflowing ? <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      hitSlop={10}
      onPress={() => setExpanded((value) => !value)}
      style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
    >
      <Text style={[styles.label, { color: colors.textMuted }]}>{t(expanded ? 'sessions.collapseMessage' : 'sessions.expandMessage')}</Text>
      <DisclosureChevron color={colors.textMuted} expanded={expanded} size={14} />
    </Pressable> : null}
  </>;
}

const styles = StyleSheet.create({
  viewport: { overflow: 'hidden' },
  // Keep the measured child at its natural height even inside the clipped viewport.
  content: { flexShrink: 0 },
  fade: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  toggle: { alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, minHeight: 28, minWidth: 48 },
  label: { fontSize: 12, fontWeight: '400' },
  pressed: { opacity: 0.65 },
});
