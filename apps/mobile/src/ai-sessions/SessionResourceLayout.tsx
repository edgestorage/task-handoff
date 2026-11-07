import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, BackHandler, Keyboard, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AdaptiveContentWidthProvider, useAdaptiveContentLayout } from '../components/adaptive-layout';
import { markdownPlainText } from '../components/SafeMarkdown';
import { ResourceBackContext, type ResourceBackHandlers } from '../components/resource-back';
import { useDetailSpace } from '../components/detail-space';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { RESOURCE_INLINE_MIN_WIDTH, resourceLayoutMode, resourceOverlayWidth, resourcePanelWidth } from './resource-workspace-model';
import { ToolActivityText } from './ToolActivityText';

export function SessionResourceLayout({ activity, children, expanded, fraction, onClose, onFractionChange, panel, topInset = 0 }: {
  activity?: { text?: string; lastMessage?: string; running: boolean };
  children: ReactNode;
  topInset?: number;
  expanded: boolean;
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
  const inline = mode === 'inline';
  const modal = expanded && !inline;
  const size = inline ? resourcePanelWidth(width, fraction) : resourceOverlayWidth(width);
  const lastMessage = activity?.lastMessage?.trim() ? markdownPlainText(activity.lastMessage).trim() : '';
  const activityText = activity?.text?.trim() || '';
  const showActivityDock = modal && Boolean(lastMessage || activityText);
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
    <Animated.View
      accessibilityElementsHidden={!expanded}
      accessibilityViewIsModal={modal}
      importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
      pointerEvents={expanded ? 'auto' : 'none'}
      style={[styles.panel, {
        backgroundColor: colors.background, borderLeftColor: colors.border, borderLeftWidth: modal ? 0 : StyleSheet.hairlineWidth, width: size,
        paddingBottom: insets.bottom, paddingRight: horizontalInsets.right, paddingLeft: modal && size >= width ? horizontalInsets.left : 0, paddingTop: topInset, top: 0,
        transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [size + 1, 0] }) }],
      }]}
      testID="session-resource-panel"
    >
      {topInset > 0 ? <View pointerEvents="none" style={[styles.topBackdrop, { backgroundColor: colors.surface, height: topInset }]} testID="session-resource-top-backdrop" /> : null}
      <View style={styles.panelContent}>
        <View style={styles.panelMain}>
          <AdaptiveContentWidthProvider availableWidth={Math.max(0, size - horizontalInsets.right - (modal && size >= width ? horizontalInsets.left : 0))}><ResourceBackContext.Provider value={backHandlers}>{panel}</ResourceBackContext.Provider></AdaptiveContentWidthProvider>
        </View>
        {showActivityDock ? <Pressable
          accessibilityHint={t('sessionResources.backToSession')}
          accessibilityLabel={[
            lastMessage ? `${t('sessionResources.lastAiMessage')}: ${lastMessage}` : '',
            activityText ? `${t('sessionResources.activity')}: ${activityText}` : '',
          ].filter(Boolean).join('\n')}
          accessibilityLiveRegion="polite"
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.activityDock, pressed && styles.activityDockPressed]}
          testID="session-resource-activity"
        >
          <View style={[styles.activityCard, { backgroundColor: colors.surface, borderColor: colors.workbenchCardBorder, shadowColor: colors.text }]}>
            {lastMessage ? <Text
              ellipsizeMode="tail"
              numberOfLines={2}
              style={[styles.activityMessage, { color: colors.textMuted }]}
              testID="session-resource-last-message"
            >{lastMessage}</Text> : null}
            {activityText ? <View style={styles.activityRow} testID="session-resource-tool-activity">
              <ToolActivityText containerStyle={styles.activityText} numberOfLines={1} running={Boolean(activity?.running)} textStyle={styles.activityTextStyle}>{activityText}</ToolActivityText>
            </View> : null}
          </View>
        </Pressable> : null}
      </View>
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
  panel: { position: 'absolute', right: 0, top: 0, bottom: 0, borderLeftWidth: StyleSheet.hairlineWidth }, topBackdrop: { position: 'absolute', left: 0, right: 0, top: 0 },
  panelContent: { flex: 1, minHeight: 0 }, panelMain: { flex: 1, minHeight: 0 },
  activityDock: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8 },
  activityDockPressed: { opacity: 0.65 },
  activityCard: { borderRadius: 16, borderWidth: 1, elevation: 3, gap: 5, paddingHorizontal: 14, paddingVertical: 10, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8 },
  activityMessage: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  activityRow: { alignItems: 'center', flexDirection: 'row', minHeight: 16 },
  activityText: { flex: 1, minWidth: 0 }, activityTextStyle: { fontSize: 12, fontWeight: '400', lineHeight: 16 },
  divider: { position: 'absolute', top: 48, bottom: 0, width: 20, alignItems: 'center', justifyContent: 'center' },
  grip: { width: 3, height: 32, borderRadius: 2 },
});
