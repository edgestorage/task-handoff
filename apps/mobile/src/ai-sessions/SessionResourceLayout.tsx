import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, BackHandler, Keyboard, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AdaptiveContentWidthProvider, useAdaptiveContentLayout } from '../components/adaptive-layout';
import { ResourceBackContext, type ResourceBackHandlers } from '../components/resource-back';
import { useDetailSpace } from '../components/detail-space';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { RESOURCE_INLINE_MIN_WIDTH, resourceLayoutMode, resourceOverlayWidth, resourcePanelWidth } from './resource-workspace-model';

export function SessionResourceLayout({ children, expanded, fullscreen, fraction, onClose, onFractionChange, panel, topInset = 0 }: {
  children: ReactNode;
  topInset?: number;
  expanded: boolean;
  fullscreen: boolean;
  fraction: number;
  onClose(): void;
  onFractionChange(value: number | ((current: number) => number)): void;
  panel: ReactNode;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState(0);
  const [mode, setMode] = useState<'overlay' | 'inline'>('overlay');
  const [reduceMotion, setReduceMotion] = useState(false);
  const [progress] = useState(() => new Animated.Value(0));
  const horizontalInsets = useAdaptiveContentLayout(Number.MAX_SAFE_INTEGER).contentInsets;
  useDetailSpace(expanded ? RESOURCE_INLINE_MIN_WIDTH + 16 : undefined);
  const inline = mode === 'inline' && !fullscreen;
  const modal = expanded && !inline;
  const size = fullscreen ? width : inline ? resourcePanelWidth(width, fraction) : resourceOverlayWidth(width);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (live) setReduceMotion(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { live = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    // Animate only measured layout; the content remains in the same React/native tree.
    const animation = Animated.timing(progress, { toValue: expanded ? 1 : 0, duration: reduceMotion ? 0 : 220, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [expanded, progress, reduceMotion]);
  const backHandlers = useMemo<ResourceBackHandlers>(() => new Map(), []);
  const previousModal = useRef(false);
  useEffect(() => {
    if (modal && !previousModal.current) Keyboard.dismiss();
    previousModal.current = modal;
  }, [modal]);
  useEffect(() => {
    if (!expanded) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      for (const handler of [...backHandlers.values()].reverse()) if (handler()) return true;
      if (!modal) return false;
      onClose();
      return true;
    });
    return () => back.remove();
  }, [backHandlers, expanded, modal, onClose]);
  const resize = useMemo(() => Gesture.Pan().runOnJS(true)
    .onChange((event) => {
      if (width) onFractionChange((current) => resourcePanelWidth(width, current - event.changeX / width) / width);
    }), [onFractionChange, width]);
  const mainWidth = inline
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [width, Math.max(0, width - size - 1)] })
    : width;
  const onLayout = (event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setWidth(nextWidth);
    setMode((previous) => resourceLayoutMode(nextWidth, previous));
  };
  return <View onLayout={onLayout} style={styles.root} testID="session-resource-layout">
    <Animated.View
      accessibilityElementsHidden={modal}
      importantForAccessibility={modal ? 'no-hide-descendants' : 'auto'}
      pointerEvents={modal ? 'none' : 'auto'}
      style={[styles.main, width ? { width: mainWidth } : styles.fill]}
      testID="session-resource-conversation"
    >
      <AdaptiveContentWidthProvider availableWidth={inline && expanded ? Math.max(0, width - size - 1) : width || undefined} horizontalInsets={{ left: horizontalInsets.left, right: inline && expanded ? 0 : horizontalInsets.right }}>{children}</AdaptiveContentWidthProvider>
    </Animated.View>
    {modal ? <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('sessionResources.collapse')} onPress={onClose} style={[StyleSheet.absoluteFill, styles.scrim]} />
    </Animated.View> : null}
    <Animated.View
      accessibilityElementsHidden={!expanded}
      accessibilityViewIsModal={modal}
      importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
      pointerEvents={expanded ? 'auto' : 'none'}
      style={[styles.panel, {
        backgroundColor: colors.background, borderLeftColor: colors.border, width: size,
        paddingBottom: insets.bottom, paddingRight: horizontalInsets.right, paddingLeft: modal && size >= width ? horizontalInsets.left : 0, top: topInset,
        transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [size + 1, 0] }) }],
      }]}
      testID="session-resource-panel"
    >
      <AdaptiveContentWidthProvider availableWidth={Math.max(0, size - horizontalInsets.right - (modal && size >= width ? horizontalInsets.left : 0))}><ResourceBackContext.Provider value={backHandlers}>{panel}</ResourceBackContext.Provider></AdaptiveContentWidthProvider>
    </Animated.View>
    {inline && expanded ? <GestureDetector gesture={resize}><View
      accessible accessibilityRole="adjustable" accessibilityLabel={t('sessionResources.resize')}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={({ nativeEvent }) => onFractionChange(fraction + (nativeEvent.actionName === 'increment' ? 0.05 : -0.05))}
      style={[styles.divider, { right: size - 9, top: topInset + 48 }]}
    ><View style={[styles.grip, { backgroundColor: colors.border }]} /></View></GestureDetector> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' }, main: { height: '100%' }, fill: { flex: 1 },
  panel: { position: 'absolute', right: 0, top: 0, bottom: 0, borderLeftWidth: StyleSheet.hairlineWidth },
  scrim: { backgroundColor: 'rgba(0,0,0,0.35)' },
  divider: { position: 'absolute', top: 48, bottom: 0, width: 20, alignItems: 'center', justifyContent: 'center' },
  grip: { width: 3, height: 32, borderRadius: 2 },
});
