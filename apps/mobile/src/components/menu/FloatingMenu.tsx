import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Animated, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { mobileWebType } from '../mobile-web-typography';
import { useMobileTheme, type MobileThemeColors } from '../theme';
import { MenuIcon } from './MenuIcon';
import { floatingMenuHasLeadingIcon, type FloatingMenuItem, type FloatingMenuPage } from './menu-model';

/** Where the menu points at, in window coordinates. `point` is set for long-press menus. */
export type FloatingMenuAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
  point?: { x: number; y: number };
};

const CARD_WIDTH = 280;
const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 6;
const ENTER_DURATION = 150;
const EXIT_DURATION = 110;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * iOS-style floating menu for Android: a rounded card anchored to its trigger (or to
 * the long-pressed point), with grouped rows, hairline separators, muted group labels,
 * leading icons/checkmarks, subtitles and nested pages.
 */
export function FloatingMenu({ anchor, onDismiss, page: initialPage }: { anchor: FloatingMenuAnchor; onDismiss(): void; page: FloatingMenuPage }) {
  const { colors } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [stack, setStack] = useState<FloatingMenuPage[]>([]);
  const [cardSize, setCardSize] = useState<{ width: number; height: number }>();
  const [dismissing, setDismissing] = useState(false);
  const [progress] = useState(() => new Animated.Value(0));
  const page = stack.length ? stack[stack.length - 1] : initialPage;

  useEffect(() => {
    if (!cardSize) return;
    Animated.timing(progress, { duration: ENTER_DURATION, toValue: 1, useNativeDriver: true }).start();
  }, [cardSize, progress]);

  const dismiss = useCallback(() => {
    if (dismissing) return;
    setDismissing(true);
    Animated.timing(progress, { duration: EXIT_DURATION, toValue: 0, useNativeDriver: true }).start(() => onDismiss());
  }, [dismissing, onDismiss, progress]);

  const width = Math.min(CARD_WIDTH, window.width - SCREEN_MARGIN * 2);
  const maxHeight = Math.max(160, window.height - insets.top - insets.bottom - SCREEN_MARGIN * 2);
  const height = Math.min(cardSize?.height ?? maxHeight, maxHeight);
  const { point } = anchor;
  const left = clamp(
    point ? point.x - width / 2 : anchor.x + anchor.width - width,
    insets.left + SCREEN_MARGIN,
    window.width - insets.right - SCREEN_MARGIN - width,
  );
  const spaceBelow = window.height - insets.bottom - SCREEN_MARGIN - (anchor.y + anchor.height);
  const spaceAbove = anchor.y - insets.top - SCREEN_MARGIN;
  const below = point ? spaceBelow >= height || spaceBelow >= spaceAbove : spaceBelow >= height;
  const preferredTop = below ? anchor.y + anchor.height + ANCHOR_GAP : anchor.y - ANCHOR_GAP - height;
  const top = clamp(preferredTop, insets.top + SCREEN_MARGIN, window.height - insets.bottom - SCREEN_MARGIN - height);

  const pick = (item: FloatingMenuItem) => {
    if (item.disabled) return;
    if (item.submenu) {
      setStack((current) => [...current, item.submenu as FloatingMenuPage]);
      return;
    }
    dismiss();
    item.onPress?.();
  };

  const leading = floatingMenuHasLeadingIcon(page.blocks);
  const rows: ReactNode[] = [];
  const separator = (key: string) => <View key={key} style={[styles.separator, { backgroundColor: colors.border }]} />;
  const label = (key: string, text: string, kind: 'title' | 'section') => (
    <Text key={key} numberOfLines={2} style={[styles.label, kind === 'title' ? styles.menuTitle : styles.sectionLabel, { color: kind === 'title' ? colors.text : colors.textMuted }]}>{text}</Text>
  );

  if (stack.length) {
    rows.push(separator('back-divider'));
    rows.push(<Pressable accessibilityRole="button" key="back" onPress={() => setStack((current) => current.slice(0, -1))} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
      <View style={styles.iconSlot}><MenuIcon color={colors.primary} name="chevron-back" size={18} /></View>
      <Text numberOfLines={1} style={[styles.menuTitle, styles.rowLabel, { color: colors.text }]}>{page.title || initialPage.title || ''}</Text>
    </Pressable>);
  }

  for (const block of page.blocks) {
    if (block.type === 'item') {
      rows.push(renderItem(block.item, colors, leading, pick));
      continue;
    }
    if (rows.length) rows.push(separator(`${block.key}-divider`));
    if (block.type === 'divider') continue;
    rows.push(label(block.key, block.label, block.type));
  }

  return <Modal animationType="none" navigationBarTranslucent onRequestClose={dismiss} statusBarTranslucent transparent visible>
    <View style={styles.root}>
      <Animated.View pointerEvents="none" style={[styles.backdrop, { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0, anchor.point ? 0.32 : 0.08] }) }]} />
      <Pressable accessibilityLabel={initialPage.title} onPress={dismiss} style={StyleSheet.absoluteFill} />
      <Animated.View
        onLayout={(event) => setCardSize({ height: event.nativeEvent.layout.height, width: event.nativeEvent.layout.width })}
        style={[styles.card, {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          left,
          maxHeight,
          opacity: progress,
          top,
          transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
          width,
        }]}
      >
        <ScrollView bounces={false} contentContainerStyle={styles.cardContent} showsVerticalScrollIndicator={false}>{rows}</ScrollView>
      </Animated.View>
    </View>
  </Modal>;
}

function renderItem(item: FloatingMenuItem, colors: MobileThemeColors, leading: boolean, pick: (item: FloatingMenuItem) => void) {
  const tint = item.disabled ? colors.textMuted : item.destructive ? colors.error : item.iconColor || colors.textMuted;
  return <Pressable
    accessibilityHint={item.subtitle}
    accessibilityLabel={item.label}
    accessibilityRole="button"
    accessibilityState={{ disabled: Boolean(item.disabled), selected: Boolean(item.selected) }}
    disabled={item.disabled}
    key={item.key}
    onPress={() => pick(item)}
    style={({ pressed }) => [styles.row, pressed && !item.disabled && { backgroundColor: colors.surface }]}
  >
    {leading ? <View style={styles.iconSlot}>
      {item.selected
        ? <MenuIcon color={item.disabled ? colors.textMuted : item.destructive ? colors.error : colors.primary} name="checkmark" size={18} />
        : item.iconSource
          ? <Image resizeMode="contain" source={item.iconSource} style={styles.iconImage} tintColor={tint} />
          : item.icon ? <MenuIcon color={tint} name={item.icon} size={20} /> : null}
    </View> : null}
    <View style={styles.copy}>
      <Text numberOfLines={2} style={[styles.rowLabel, { color: item.disabled ? colors.textMuted : item.destructive ? colors.error : colors.text, opacity: item.disabled ? 0.55 : 1 }]}>{item.label}</Text>
      {item.subtitle ? <Text numberOfLines={2} style={[styles.subtitle, { color: colors.textMuted }]}>{item.subtitle}</Text> : null}
    </View>
    {item.submenu ? <MenuIcon color={colors.textMuted} name="chevron-forward" size={18} /> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: '#000000', bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: undefined,
    elevation: 14,
    overflow: 'hidden',
    position: 'absolute',
    shadowColor: '#000000',
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 20,
  },
  cardContent: { paddingVertical: 4 },
  copy: { flex: 1, gap: 1 },
  iconImage: { height: 20, width: 20 },
  iconSlot: { alignItems: 'center', justifyContent: 'center', minWidth: 22 },
  label: { fontSize: mobileWebType.small, fontWeight: '600', lineHeight: mobileWebType.smallLine, paddingHorizontal: 16, paddingVertical: 6 },
  menuTitle: { fontSize: mobileWebType.body, fontWeight: '700', lineHeight: mobileWebType.metaLine },
  root: { flex: 1 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 44, paddingHorizontal: 16, paddingVertical: 11 },
  rowLabel: { fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  sectionLabel: { textTransform: 'none' },
  separator: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  subtitle: { fontSize: mobileWebType.meta, lineHeight: mobileWebType.metaLine },
});
