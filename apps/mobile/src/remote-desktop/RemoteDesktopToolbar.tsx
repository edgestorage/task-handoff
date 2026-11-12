import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { ChevronDown, ChevronUp, Hand, Keyboard, MousePointer2, type LucideIcon } from 'lucide-react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { AnchoredSelectMenu, type AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import { useI18n } from '../i18n';
import { shouldShowControlRequest } from './control-presentation';
import type { RemoteDesktopMouseMode } from './preferences';
import type { RemoteDesktopSnapshot } from './types';

const EXPAND_DURATION_MS = 220;
const COLLAPSE_DURATION_MS = 160;
const RESIZE_DURATION_MS = 190;
const COLLAPSED_SIZE = 44;
const EXPANDED_RADIUS = 24;
const COLLAPSED_RADIUS = 22;
const ACTION_WIDTH = 72;
const ACTION_ICON_SIZE = 20;
const CHEVRON_SIZE = 18;
const CONTENT_PADDING = 5;
const DIVIDER_MARGIN = 4;
const COLLAPSE_BUTTON_WIDTH = 32;
const SURFACE_BORDER = StyleSheet.hairlineWidth;
const ACTION_ROW_CHROME_WIDTH = CONTENT_PADDING * 2 + DIVIDER_MARGIN * 2 + SURFACE_BORDER + COLLAPSE_BUTTON_WIDTH + SURFACE_BORDER * 2;
const ACTION_ROW_CHROME_HEIGHT = CONTENT_PADDING * 2 + SURFACE_BORDER * 2;
const CONTROL_BUTTON_ENTERING = FadeIn.duration(170).easing(Easing.out(Easing.cubic)).reduceMotion(ReduceMotion.System);
const CONTROL_BUTTON_EXITING = FadeOut.duration(130).easing(Easing.in(Easing.cubic)).reduceMotion(ReduceMotion.System);

type Props = {
  bottomInset: number;
  hidden?: boolean;
  keyboardVisible: boolean;
  mouseMode: RemoteDesktopMouseMode;
  obscured?: boolean;
  onInput(): void;
  onKeyboard(): void;
  onMouseMode(value: RemoteDesktopMouseMode): void;
  snapshot: RemoteDesktopSnapshot;
};

export function RemoteDesktopToolbar(props: Props) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [actionRowSize, setActionRowSize] = useState<{ height: number; width: number }>();
  const expansion = useSharedValue(collapsed ? 0 : 1);
  const targetWidth = useSharedValue(COLLAPSED_SIZE);
  const targetHeight = useSharedValue(COLLAPSED_SIZE);
  const measured = useRef(false);
  const viewport = useWindowDimensions();
  const viewportWidth = useRef(viewport.width);
  const { snapshot } = props;
  const canControl = snapshot.phase === 'connected' || snapshot.phase === 'paused' || Boolean(snapshot.path);
  const inputBusy = snapshot.inputPending || snapshot.controlRequestPending;
  const inputLabel = inputBusy ? t('remoteDesktop.requestingControl') : t('remoteDesktop.requestControl');
  const keyboardText = props.keyboardVisible ? t('remoteDesktop.toolbarHideKeyboard') : t('remoteDesktop.toolbarKeyboard');
  const mouseOptions: AnchoredSelectOption<RemoteDesktopMouseMode>[] = [
    { description: t('remoteDesktop.directTouchDescription'), value: 'direct', label: t('remoteDesktop.directTouch'), systemImage: 'hand.tap' },
    { description: t('remoteDesktop.trackpadDescription'), value: 'trackpad', label: t('remoteDesktop.trackpad'), systemImage: 'rectangle.and.hand.point.up.left' },
  ];
  const bottom = Math.max(8, props.bottomInset + 6);

  useEffect(() => {
    expansion.value = withTiming(collapsed ? 0 : 1, {
      duration: collapsed ? COLLAPSE_DURATION_MS : EXPAND_DURATION_MS,
      easing: collapsed ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [collapsed, expansion]);

  useEffect(() => {
    if (viewportWidth.current === viewport.width) return;
    viewportWidth.current = viewport.width;
    if (!measured.current || !actionRowSize) return;
    targetWidth.set(withTiming(toolbarWidth(actionRowSize.width, viewport.width), {
      duration: RESIZE_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    }));
  }, [actionRowSize, targetWidth, viewport.width]);

  const surfaceStyle = useAnimatedStyle(() => {
    if (!measured) return {};
    const expandedWidth = targetWidth.value;
    const centerOffset = 14 - (viewport.width - expandedWidth) / 2;
    return {
      borderRadius: interpolate(expansion.value, [0, 1], [COLLAPSED_RADIUS, EXPANDED_RADIUS]),
      height: interpolate(expansion.value, [0, 1], [COLLAPSED_SIZE, targetHeight.value]),
      transform: [{ translateX: centerOffset * expansion.value }],
      width: interpolate(expansion.value, [0, 1], [COLLAPSED_SIZE, expandedWidth]),
    };
  });
  const clipStyle = useAnimatedStyle(() => ({
    borderRadius: interpolate(expansion.value, [0, 1], [COLLAPSED_RADIUS, EXPANDED_RADIUS]),
  }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expansion.value, [0, 0.42, 1], [0, 0, 1]),
  }));
  const collapsedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expansion.value, [0, 0.3, 1], [1, 0.9, 0]),
    transform: [{ scale: interpolate(expansion.value, [0, 0.3, 1], [1, 1, 0.88]) }],
  }));

  const measureActions = (event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    const previous = actionRowSize;
    if (previous?.width === width && previous.height === height) return;
    const nextWidth = toolbarWidth(width, viewport.width);
    const nextHeight = height + ACTION_ROW_CHROME_HEIGHT;
    if (!measured.current) {
      targetWidth.set(nextWidth);
      targetHeight.set(nextHeight);
      measured.current = true;
    } else {
      targetWidth.set(withTiming(nextWidth, {
        duration: RESIZE_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }));
      targetHeight.set(withTiming(nextHeight, {
        duration: RESIZE_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }));
    }
    setActionRowSize({ height, width });
  };

  return <Animated.View
    accessibilityElementsHidden={props.obscured || props.hidden}
    importantForAccessibility={props.obscured || props.hidden ? 'no-hide-descendants' : 'auto'}
    pointerEvents={props.obscured || props.hidden ? 'none' : 'auto'}
    style={[styles.root, { bottom }, actionRowSize ? surfaceStyle : undefined, props.hidden && styles.hidden]}
    testID="remote-desktop-toolbar"
  >
    <Animated.View style={[styles.clip, actionRowSize ? styles.clipMeasured : undefined, actionRowSize ? clipStyle : undefined]}>
      <Animated.View
        accessibilityElementsHidden={collapsed}
        importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
        pointerEvents={collapsed ? 'none' : 'auto'}
        style={[styles.content, contentStyle]}
      >
        <View onLayout={measureActions} style={styles.actions} testID="remote-desktop-toolbar-actions">
          {shouldShowControlRequest(snapshot) ? <Animated.View entering={CONTROL_BUTTON_ENTERING} exiting={CONTROL_BUTTON_EXITING} style={styles.actionSlot}><ToolbarButton busy={inputBusy} disabled={!canControl} icon={Hand} label={inputLabel} text={t('remoteDesktop.toolbarControl')} onPress={props.onInput} /></Animated.View> : null}
          <ToolbarButton active={props.keyboardVisible} disabled={!snapshot.inputEnabled} icon={Keyboard} label={props.keyboardVisible ? t('remoteDesktop.hideKeyboard') : t('remoteDesktop.keyboard')} text={keyboardText} onPress={props.onKeyboard} />
          <AnchoredSelectMenu
            cancelLabel={t('common.cancel')}
            disabled={!snapshot.inputEnabled}
            onSelect={props.onMouseMode}
            options={mouseOptions}
            selectedValue={props.mouseMode}
            title={t('remoteDesktop.mouseMode')}
          >
            {(open) => <ToolbarButton active={props.mouseMode === 'trackpad'} disabled={!snapshot.inputEnabled} icon={MousePointer2} label={t('remoteDesktop.mouseMode')} text={t('remoteDesktop.toolbarMouse')} onPress={open} />}
          </AnchoredSelectMenu>
        </View>
        <View style={styles.divider} />
        <Pressable accessibilityLabel={t('remoteDesktop.hideToolbar')} accessibilityRole="button" hitSlop={8} onPress={() => setCollapsed(true)} style={({ pressed }) => [styles.collapseButton, pressed && styles.pressed]}>
          <ChevronDown color={TOOLBAR_MUTED} size={CHEVRON_SIZE} strokeWidth={1.9} />
        </Pressable>
      </Animated.View>
      <Animated.View
        accessibilityElementsHidden={!collapsed}
        importantForAccessibility={collapsed ? 'auto' : 'no-hide-descendants'}
        pointerEvents={collapsed ? 'auto' : 'none'}
        style={[styles.collapsedControl, collapsedStyle]}
      >
        <Pressable accessibilityLabel={t('remoteDesktop.showToolbar')} accessibilityRole="button" hitSlop={8} onPress={() => setCollapsed(false)} style={({ pressed }) => [styles.collapsedButton, snapshot.inputEnabled && styles.collapsedButtonActive, pressed && styles.pressed]}>
          <ChevronUp color={snapshot.inputEnabled ? TOOLBAR_ACTIVE : TOOLBAR_MUTED} size={CHEVRON_SIZE} strokeWidth={1.9} />
          {snapshot.inputEnabled ? <View style={styles.collapsedDot} /> : null}
        </Pressable>
      </Animated.View>
    </Animated.View>
  </Animated.View>;
}

function ToolbarButton({ active = false, busy = false, disabled = false, icon: IconComponent, label, text, onPress }: {
  active?: boolean; busy?: boolean; disabled?: boolean; icon: LucideIcon; label: string; text: string; onPress?: () => void;
}) {
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ busy, disabled, selected: active }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, active && styles.actionActive, disabled && styles.disabled, pressed && styles.pressed]}>
    <View style={styles.icon}>
      {busy ? <ActivityIndicator color={TOOLBAR_ACTIVE} size="small" /> : <IconComponent color={active ? TOOLBAR_ACTIVE : TOOLBAR_INACTIVE} size={ACTION_ICON_SIZE} strokeWidth={1.9} />}
    </View>
    <Text numberOfLines={1} style={[styles.label, { color: active ? TOOLBAR_ACTIVE : TOOLBAR_MUTED }]}>{text}</Text>
  </Pressable>;
}

const TOOLBAR_ACTIVE = '#9fd2ff';
const TOOLBAR_INACTIVE = 'rgba(255,255,255,0.88)';
const TOOLBAR_MUTED = 'rgba(255,255,255,0.58)';

function toolbarWidth(actionsWidth: number, viewportWidth: number) {
  return Math.min(actionsWidth + ACTION_ROW_CHROME_WIDTH, viewportWidth * 0.94);
}

const styles = StyleSheet.create({
  root: { backgroundColor: 'rgba(20,21,25,0.92)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: StyleSheet.hairlineWidth, maxWidth: '94%', position: 'absolute', right: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.28, shadowRadius: 18 },
  hidden: { display: 'none' },
  clip: { borderRadius: EXPANDED_RADIUS, overflow: 'hidden' },
  clipMeasured: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  content: { alignItems: 'center', flexDirection: 'row', paddingHorizontal: CONTENT_PADDING, paddingVertical: CONTENT_PADDING },
  actions: { alignItems: 'center', flexDirection: 'row', gap: 2 },
  actionSlot: { width: ACTION_WIDTH },
  action: { alignItems: 'center', borderRadius: 18, justifyContent: 'center', minHeight: 48, paddingHorizontal: 4, width: ACTION_WIDTH },
  actionActive: { backgroundColor: 'rgba(91,161,255,0.16)' },
  icon: { alignItems: 'center', height: 24, justifyContent: 'center', width: 24 },
  label: { fontSize: 12, lineHeight: 15, marginTop: 1, textAlign: 'center' },
  divider: { backgroundColor: 'rgba(255,255,255,0.12)', height: 24, marginHorizontal: DIVIDER_MARGIN, width: SURFACE_BORDER },
  collapseButton: { alignItems: 'center', borderRadius: 16, height: 48, justifyContent: 'center', width: COLLAPSE_BUTTON_WIDTH },
  disabled: { opacity: 0.36 },
  pressed: { opacity: 0.55 },
  collapsedControl: { alignItems: 'center', bottom: 0, height: COLLAPSED_SIZE, justifyContent: 'center', position: 'absolute', right: 0, width: COLLAPSED_SIZE },
  collapsedButton: { alignItems: 'center', backgroundColor: 'rgba(20,21,25,0.92)', borderColor: 'rgba(255,255,255,0.12)', borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, height: 44, justifyContent: 'center', width: 44 },
  collapsedButtonActive: { borderColor: 'rgba(159,210,255,0.5)' },
  collapsedDot: { backgroundColor: TOOLBAR_ACTIVE, borderRadius: 3, height: 6, position: 'absolute', right: 7, top: 7, width: 6 },
});
