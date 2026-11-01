import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheet, BottomSheetView, type BottomSheetMethods } from '@expo/ui/community/bottom-sheet';

import {
  approvalCenterBadgeText,
  type ApprovalCenterItem,
  type ApprovalCenterSource,
  type ApprovalCenterSourceHealth,
} from '@task-handoff/control-plane-client';

import { useAdaptiveContentLayout } from '../components/adaptive-layout';
import { Icon, type IconName } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { ApprovalDetailBody } from './ApprovalDetailBody';
import { ApprovalInlineActions } from './ApprovalInlineActions';
import {
  actionErrorMessage,
  deviceRoleAvailable,
  itemContextLines,
  itemSource,
  itemSourceDetail,
  itemTitle,
  sourceLabel,
} from './approval-detail-model';
import {
  APPROVAL_CENTER_EDGE_VISIBLE_SIZE,
  APPROVAL_CENTER_FAB_SIZE,
  approvalCenterHeaderFallback,
  clampApprovalCenter,
  mobileApprovalCenterLayout,
  resistedApprovalCenterDrag,
  resolveApprovalCenterDrop,
  type ApprovalCenterFabPlacement,
} from './geometry';
import {
  useApprovalCenterOcclusion,
  useMobileApprovalCenter,
} from './use-mobile-approval-center';

const SOURCE_ORDER: readonly ApprovalCenterSource[] = [
  'ai-session-approval',
  'story-decision',
  'operation-approval',
  'device-trust',
  'node-control-plane-trust',
];

const PRESS_SUPPRESSION_AFTER_DRAG_MS = 120;

type ApprovalItem = ApprovalCenterItem;

export function sourceIcon(source: ApprovalCenterSource): IconName {
  switch (source) {
    case 'ai-session-approval': return 'shield-outline';
    case 'story-decision': return 'book-outline';
    case 'operation-approval': return 'shield-checkmark-outline';
    case 'device-trust': return 'shield-checkmark-outline';
    case 'node-control-plane-trust': return 'shield-checkmark-outline';
  }
}

export function approvalFabIcon(expanded: boolean): IconName {
  return expanded ? 'chevron-down' : 'shield-checkmark-outline';
}

export function MobileApprovalCenterOverlay() {
  const center = useMobileApprovalCenter();
  if (!center.pendingCount) return null;
  return <MobileApprovalCenterOverlayContent />;
}

function MobileApprovalCenterOverlayContent() {
  const center = useMobileApprovalCenter();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const adaptive = useAdaptiveContentLayout();
  const { height, width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const pressSuppressionUntilRef = useRef(0);

  const placement: ApprovalCenterFabPlacement = {
    dockSide: center.dockSide,
    verticalRatio: center.verticalRatio,
    visibility: center.edgeHidden ? 'edge-hidden' : 'docked',
  };
  const headerHeight = center.headerInset > 0
    ? center.headerInset
    : approvalCenterHeaderFallback(Platform.OS, insets.top);
  const layout = mobileApprovalCenterLayout({
    adaptiveInsets: adaptive.contentInsets,
    bottomInset: insets.bottom,
    contentWidth: adaptive.contentWidth,
    headerHeight,
    obstructionHeight: center.obstructionHeight,
    placement,
    platform: Platform.OS,
    windowHeight: height,
    windowWidth: width,
  });
  const [fabPosition] = useState(() => new Animated.ValueXY(layout.fab));
  const positionRef = useRef(layout.fab);

  const animateTo = useCallback((x: number, y: number) => {
    fabPosition.stopAnimation();
    if (reduceMotion) {
      fabPosition.setValue({ x, y });
      return;
    }
    Animated.spring(fabPosition, {
      damping: 24,
      mass: 0.8,
      stiffness: 280,
      toValue: { x, y },
      useNativeDriver: false,
    }).start();
  }, [fabPosition, reduceMotion]);

  const dragContext = useRef({ animateTo, center, fabPosition, layout });
  useLayoutEffect(() => {
    dragContext.current = { animateTo, center, fabPosition, layout };
  }, [animateTo, center, fabPosition, layout]);

  useEffect(() => {
    const listener = fabPosition.addListener((value) => { positionRef.current = value; });
    return () => fabPosition.removeListener(listener);
  }, [fabPosition]);

  useEffect(() => {
    if (draggingRef.current) return;
    animateTo(layout.fab.x, layout.fab.y);
  }, [animateTo, layout.fab.x, layout.fab.y]);

  const shouldStartDrag = (_event: unknown, gesture: { dx: number; dy: number }) => (
    Math.abs(gesture.dx) >= 4 || Math.abs(gesture.dy) >= 4
  );
  // PanResponder retains these callbacks; dragContext keeps the latest layout and actions current.
  // eslint-disable-next-line react-hooks/refs
  const [panResponder] = useState(() => PanResponder.create({
    onMoveShouldSetPanResponder: shouldStartDrag,
    onMoveShouldSetPanResponderCapture: shouldStartDrag,
    onPanResponderGrant: () => {
      dragStartRef.current = positionRef.current;
      draggingRef.current = true;
      pressSuppressionUntilRef.current = Number.POSITIVE_INFINITY;
      setDragging(true);
      dragContext.current.center.collapse();
    },
    onPanResponderMove: (_event, gesture) => {
      const { bounds } = dragContext.current.layout;
      dragContext.current.fabPosition.setValue({
        x: resistedApprovalCenterDrag(dragStartRef.current.x + gesture.dx, bounds.minX, bounds.maxX),
        y: clampApprovalCenter(dragStartRef.current.y + gesture.dy, bounds.minY, bounds.maxY),
      });
    },
    onPanResponderRelease: (_event, gesture) => {
      const { center: currentCenter, layout: currentLayout } = dragContext.current;
      const x = dragStartRef.current.x + gesture.dx;
      const y = dragStartRef.current.y + gesture.dy;
      const next = resolveApprovalCenterDrop({ bounds: currentLayout.bounds, velocityX: gesture.vx, x, y });
      draggingRef.current = false;
      setDragging(false);
      currentCenter.setFabPlacement(next);
      pressSuppressionUntilRef.current = Date.now() + PRESS_SUPPRESSION_AFTER_DRAG_MS;
    },
    onPanResponderTerminate: () => {
      const { animateTo: animate, layout: currentLayout } = dragContext.current;
      draggingRef.current = false;
      setDragging(false);
      pressSuppressionUntilRef.current = Date.now() + PRESS_SUPPRESSION_AFTER_DRAG_MS;
      animate(currentLayout.fab.x, currentLayout.fab.y);
    },
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }));

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!center.expanded) return;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ animated: false, y: center.scrollOffset });
    });
    return () => cancelAnimationFrame(frame);
  }, [center.expanded, center.scrollOffset]);

  if (!center.pendingCount) return null;

  const unavailable = SOURCE_ORDER
    .map((source) => center.sourceHealth[source]?.health)
    .filter((health): health is ApprovalCenterSourceHealth => Boolean(health && (health.phase === 'stale' || health.phase === 'unavailable')));
  const stateLabel = center.edgeHidden
    ? t('approvalCenter.hidden')
    : center.expanded ? t('approvalCenter.expanded') : t('approvalCenter.collapsed');

  return <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="mobile-approval-center">
    {center.expanded ? <Pressable
      accessibilityLabel={t('approvalCenter.collapse')}
      accessibilityRole="button"
      onPress={center.expandOrCollapse}
      style={styles.backdrop}
      testID="mobile-approval-backdrop"
    /> : null}

    {center.expanded ? <View
      accessibilityLabel={`${t('approvalCenter.title')}, ${t('approvalCenter.pendingCount', { count: center.pendingCount })}`}
      style={[
        styles.panel,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
        },
        layout.panel,
      ]}
      testID="mobile-approval-panel"
    >
      <View style={[styles.panelHeader, { borderBottomColor: colors.border }]}>
        <Icon color={colors.primary} name="shield-checkmark-outline" size={24} />
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" style={[styles.panelTitle, { color: colors.text }]}>{t('approvalCenter.title')}</Text>
          <Text style={[styles.panelSubtitle, { color: colors.textMuted }]}>{t('approvalCenter.pendingCount', { count: center.pendingCount })}</Text>
        </View>
        <Pressable
          accessibilityLabel={t('approvalCenter.collapse')}
          accessibilityRole="button"
          hitSlop={8}
          onPress={center.expandOrCollapse}
          style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? colors.workbenchSelectionBackground : colors.background }]}
        >
          <Icon color={colors.textMuted} name="chevron-down" size={20} />
        </Pressable>
      </View>

      {unavailable.length ? <View
        accessibilityHint={t('approvalCenter.diagnosticsDescription')}
        style={[styles.diagnostics, { backgroundColor: colors.notice, borderColor: colors.noticeText }]}
        testID="mobile-approval-diagnostics"
      >
        <Icon color={colors.noticeText} name="cloud-offline-outline" size={18} />
        <View style={styles.headerCopy}>
          <Text style={[styles.diagnosticTitle, { color: colors.noticeText }]}>{t('approvalCenter.diagnosticsTitle')}</Text>
          <Text numberOfLines={2} style={[styles.diagnosticText, { color: colors.noticeText }]}>{unavailable.map((health) => sourceLabel(health.source, t)).join(' · ')}</Text>
        </View>
        {unavailable.some((health) => health.retryable) ? <Pressable
          accessibilityLabel={t('approvalCenter.retry')}
          accessibilityRole="button"
          onPress={() => center.retry(unavailable.filter((health) => health.retryable).length === 1 ? unavailable.find((health) => health.retryable)?.source : undefined)}
          style={({ pressed }) => [styles.smallAction, { backgroundColor: pressed ? colors.noticeText : 'transparent', borderColor: colors.noticeText }]}
        >
          <Text style={[styles.smallActionText, { color: colors.noticeText }]}>{t('approvalCenter.retry')}</Text>
        </Pressable> : null}
      </View> : null}

      <ScrollView
        accessibilityLabel={t('approvalCenter.listLabel')}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => center.setScrollOffset(event.nativeEvent.contentOffset.y)}
        ref={scrollRef}
        scrollEventThrottle={100}
        showsVerticalScrollIndicator
        style={styles.list}
        testID="mobile-approval-list"
      >
        {center.items.map((item) => <ApprovalItemCard center={center} item={item} key={item.key} />)}
      </ScrollView>
    </View> : null}

    <Animated.View
      style={[
        styles.fab,
        {
          left: fabPosition.x,
          top: fabPosition.y,
          transform: [{ scale: dragging ? 1.05 : 1 }],
        },
      ]}
      testID="mobile-approval-fab-container"
      {...panResponder.panHandlers}
    >
      <Pressable
        accessibilityHint={t('approvalCenter.fabHint')}
        accessibilityLabel={`${t('approvalCenter.fabLabel', { count: center.pendingCount })}, ${stateLabel}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: center.expanded }}
        hitSlop={center.edgeHidden
          ? {
            bottom: 8,
            left: center.dockSide === 'right' ? APPROVAL_CENTER_FAB_SIZE - APPROVAL_CENTER_EDGE_VISIBLE_SIZE : 0,
            right: center.dockSide === 'left' ? APPROVAL_CENTER_FAB_SIZE - APPROVAL_CENTER_EDGE_VISIBLE_SIZE : 0,
            top: 8,
          }
          : 4}
        onPress={() => {
          if (Date.now() < pressSuppressionUntilRef.current) return;
          if (center.edgeHidden) center.revealAndExpand();
          else center.expandOrCollapse();
        }}
        onPressIn={() => { pressSuppressionUntilRef.current = 0; }}
        style={({ pressed }) => [
          styles.fabSurface,
          {
            backgroundColor: pressed ? colors.primaryButton : colors.primary,
            opacity: pressed ? 0.9 : 1,
          },
        ]}
        testID="mobile-approval-fab"
      >
        <Icon color="#ffffff" name={approvalFabIcon(center.expanded)} size={21} testID="mobile-approval-fab-icon" />
        <View
          accessibilityElementsHidden
          style={[
            styles.badge,
            { backgroundColor: colors.error, borderColor: colors.surface },
            center.edgeHidden
              ? center.dockSide === 'right' ? styles.badgeHiddenRight : styles.badgeHiddenLeft
              : styles.badgeDockedRight,
          ]}
        >
          <Text adjustsFontSizeToFit numberOfLines={1} style={styles.badgeText}>{approvalCenterBadgeText(center.pendingCount)}</Text>
        </View>
      </Pressable>
    </Animated.View>

    <ApprovalDetailPresentation />

  </View>;
}

function ApprovalItemCard({ center, item }: {
  center: ReturnType<typeof useMobileApprovalCenter>;
  item: ApprovalItem;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const action = center.actions[item.key];
  const busy = action?.phase === 'busy';
  const failed = action?.phase === 'failed' || action?.phase === 'result-unknown';
  const selected = center.selectedKey === item.key;
  const sourceUnavailable = center.sourceHealth[itemSource(item)]?.health.phase !== 'ready';
  const roleUnavailable = item.type === 'device-trust' && !deviceRoleAvailable(item);
  const open = () => {
    center.selectItem(item.key);
    center.setDetailItem(item);
  };

  return <View
    key={item.key}
    style={[styles.item, {
      backgroundColor: selected ? colors.workbenchSelectionBackground : 'transparent',
      borderBottomColor: colors.border,
    }]}
    testID={`mobile-approval-item-${item.key}`}
  >
    <Pressable
      accessibilityHint={t('approvalCenter.openDetailsHint')}
      accessibilityLabel={`${sourceLabel(itemSource(item), t)}. ${itemTitle(item, t)}. ${itemSourceDetail(item)}`}
      accessibilityRole="button"
      onPress={open}
      style={styles.itemPressable}
    >
      <View style={styles.itemHead}>
        <View style={[styles.kindBadge, { backgroundColor: colors.background }]}>
          <Icon color={colors.textMuted} name={sourceIcon(itemSource(item))} size={13} testID={`approval-source-icon-${itemSource(item)}`} />
          <Text numberOfLines={1} style={[styles.kindText, { color: colors.textMuted }]}>{sourceLabel(itemSource(item), t)}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.sourceText, { color: colors.textMuted }]}>{itemSourceDetail(item)}</Text>
        <Icon color={colors.textMuted} name="chevron-forward" size={16} />
      </View>
      <Text numberOfLines={2} style={[styles.itemTitle, { color: colors.text }]}>{itemTitle(item, t)}</Text>
      {itemContextLines(item, t).map((line) => <Text key={line} numberOfLines={2} style={[styles.itemSummary, { color: colors.textMuted }]}>{line}</Text>)}
      {roleUnavailable ? <Text style={[styles.itemSummary, { color: colors.error }]}>{t('approvalCenter.roleUnavailable')}</Text> : null}
    </Pressable>
    <ApprovalInlineActions
      disabled={busy || sourceUnavailable}
      item={item}
      onDecision={(decision) => center.decide(item, { decision })}
      onOpen={open}
      roleUnavailable={roleUnavailable}
      testID={`approval-actions-${item.key}`}
    />
    {failed ? <Text accessibilityLiveRegion="polite" style={[styles.actionError, { color: colors.error }]}>{actionErrorMessage(action?.error, t)}</Text> : null}
    {busy ? <View style={styles.busyRow}><ActivityIndicator color={colors.primary} size="small" /><Text accessibilityLiveRegion="polite" style={[styles.itemMeta, { color: colors.textMuted }]}>{t('approvalCenter.submitting')}</Text></View> : null}
  </View>;
}

function ApprovalDetailPresentation() {
  const center = useMobileApprovalCenter();
  const item = center.detailItem;
  useApprovalCenterOcclusion('modal', Boolean(item));

  if (!item) return null;
  return <ApprovalDetailSheet item={item} onDismiss={() => {
    // The row highlight only marks the item while its sheet is open; leaving it
    // behind would make the list row look like a permanently selected block.
    center.selectItem(undefined);
    center.setDetailItem(undefined);
  }} />;
}

function ApprovalDetailSheet({ item, onDismiss }: { item: ApprovalCenterItem; onDismiss(): void }) {
  const { colors } = useMobileTheme();
  const sheetRef = useRef<BottomSheetMethods>(null);
  const dismiss = () => {
    const sheet = sheetRef.current;
    if (sheet) sheet.close();
    else onDismiss();
  };
  return <BottomSheet
    backgroundStyle={{ backgroundColor: colors.background }}
    enablePanDownToClose
    index={1}
    onClose={onDismiss}
    ref={sheetRef}
    snapPoints={['50%', '100%']}
  >
    <BottomSheetView style={[styles.detailSheetSurface, { backgroundColor: colors.background }]}>
      <ApprovalDetailContent item={item} key={item.key} onClose={dismiss} />
    </BottomSheetView>
  </BottomSheet>;
}

function ApprovalDetailContent({ item, onClose }: { item: ApprovalCenterItem; onClose(): void }) {
  const center = useMobileApprovalCenter();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [optionId, setOptionId] = useState<string>();
  const [response, setResponse] = useState('');
  const action = center.actions[item.key];
  const busy = action?.phase === 'busy';
  const failed = action?.phase === 'failed' || action?.phase === 'result-unknown';
  const sourceUnavailable = center.sourceHealth[itemSource(item)]?.health.phase !== 'ready';
  const roleUnavailable = item.type === 'device-trust' && !deviceRoleAvailable(item);
  return <View accessibilityViewIsModal style={[styles.detailRoot, { backgroundColor: colors.background }]} testID="mobile-approval-detail">
    <View style={[styles.detailHeader, { backgroundColor: colors.background }]} testID="mobile-approval-detail-header">
      <View style={[styles.detailHeaderBadge, { backgroundColor: colors.primarySoft }]}>
        <Icon color={colors.primary} name={sourceIcon(itemSource(item))} size={18} testID="mobile-approval-detail-source-icon" />
      </View>
      <View style={styles.headerCopy}>
        <Text accessibilityRole="header" numberOfLines={2} style={[styles.panelTitle, { color: colors.text }]}>{itemTitle(item, t)}</Text>
        <Text numberOfLines={1} style={[styles.panelSubtitle, { color: colors.textMuted }]}>{sourceLabel(itemSource(item), t)}</Text>
      </View>
      <Pressable
        accessibilityLabel={t('approvalCenter.close')}
        accessibilityRole="button"
        hitSlop={8}
        onPress={onClose}
        style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? colors.workbenchSelectionBackground : colors.surface }]}
      >
        <Icon color={colors.textMuted} name="close" size={18} />
      </Pressable>
    </View>
    <ApprovalDetailBody
      busy={busy}
      errorText={failed ? actionErrorMessage(action?.error, t) : undefined}
      failed={failed}
      item={item}
      onDecision={(decision) => center.decide(item, { decision })}
      onOption={setOptionId}
      onResponse={setResponse}
      onSubmitStory={() => center.decide(item, { optionId, response: response.trim() || undefined, retry: action?.error === 'STORY_RETRY_REQUIRED' })}
      optionId={optionId}
      response={response}
      retryStory={action?.error === 'STORY_RETRY_REQUIRED'}
      roleUnavailable={roleUnavailable}
      sourceUnavailable={sourceUnavailable}
    />
  </View>;
}

const styles = StyleSheet.create({
  actionError: { fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingBottom: 10 },
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 930,
  },
  badge: { alignItems: 'center', borderRadius: 10, borderWidth: 2, justifyContent: 'center', minHeight: 18, minWidth: 18, paddingHorizontal: 4, position: 'absolute', top: -4 },
  badgeDockedRight: { right: -4 },
  badgeHiddenLeft: { right: -4 },
  badgeHiddenRight: { left: -4 },
  badgeText: { color: '#ffffff', fontSize: 12, fontVariant: ['tabular-nums'], fontWeight: '700', lineHeight: 16 },
  busyRow: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingBottom: 10, paddingHorizontal: 12 },
  detailHeader: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 60, paddingHorizontal: 14, paddingVertical: 8 },
  detailHeaderBadge: { alignItems: 'center', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  detailRoot: { flex: 1 },
  detailSheetSurface: { flex: 1, minHeight: 0 },
  diagnostics: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 9 },
  diagnosticText: { fontSize: 12, lineHeight: 16 },
  diagnosticTitle: { fontSize: 13, lineHeight: 17 },
  fab: { height: APPROVAL_CENTER_FAB_SIZE, position: 'absolute', width: APPROVAL_CENTER_FAB_SIZE, zIndex: 950 },
  fabSurface: { alignItems: 'center', borderRadius: APPROVAL_CENTER_FAB_SIZE / 2, elevation: 10, height: APPROVAL_CENTER_FAB_SIZE, justifyContent: 'center', shadowColor: '#000', shadowOffset: { height: 4, width: 0 }, shadowOpacity: 0.24, shadowRadius: 9, width: APPROVAL_CENTER_FAB_SIZE },
  headerCopy: { flex: 1, gap: 2 },
  iconButton: { alignItems: 'center', borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },
  item: { borderBottomWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  itemHead: { alignItems: 'center', flexDirection: 'row', gap: 8, minWidth: 0 },
  itemMeta: { fontSize: 12, lineHeight: 17 },
  itemPressable: { gap: 4, paddingHorizontal: 14, paddingTop: 12 },
  itemSummary: { fontSize: 12, lineHeight: 17 },
  itemTitle: { fontSize: 14, lineHeight: 20 },
  kindBadge: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', flexShrink: 0, gap: 4, paddingHorizontal: 7, paddingVertical: 2 },
  kindText: { fontSize: 12, lineHeight: 16 },
  list: { flexShrink: 1 },
  listContent: { padding: 0 },
  panel: { borderRadius: 14, borderWidth: 1, elevation: 14, overflow: 'hidden', position: 'absolute', shadowColor: '#000', shadowOffset: { height: 7, width: 0 }, shadowOpacity: 0.24, shadowRadius: 18, zIndex: 940 },
  panelHeader: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 8 },
  panelSubtitle: { fontSize: 12, lineHeight: 17 },
  panelTitle: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  smallAction: { alignItems: 'center', borderRadius: 8, borderWidth: 1, justifyContent: 'center', minHeight: 36, paddingHorizontal: 9 },
  smallActionText: { fontSize: 12, lineHeight: 17 },
  sourceText: { flex: 1, fontSize: 12, lineHeight: 17 },
  visuallyHidden: { height: 1, opacity: 0, position: 'absolute', width: 1 },
});
