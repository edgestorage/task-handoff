import { useContext, useEffect, useMemo, type ReactNode } from 'react';
import { BackHandler, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { AdaptiveContentWidthProvider } from './adaptive-layout';
import { EmptyState } from './EmptyState';
import { useMobileTheme } from './theme';
import type { IconName } from './Icon';

/** Below this usable width the native stack keeps the compact single-column flow. */
export const MASTER_DETAIL_MIN_WIDTH = 720;
export const MASTER_DETAIL_LIST_MIN_WIDTH = 300;
export const MASTER_DETAIL_LIST_MAX_WIDTH = 352;
export const MASTER_DETAIL_DETAIL_MIN_WIDTH = 420;

export type MasterDetailMetrics = {
  availableWidth: number;
  detailWidth: number;
  listWidth: number;
  wide: boolean;
};

export function masterDetailMetrics(
  windowWidth: number,
  safeAreaInsets: Partial<{ left: number; right: number }> = {},
): MasterDetailMetrics {
  const left = Math.max(0, safeAreaInsets.left ?? 0);
  const right = Math.max(0, safeAreaInsets.right ?? 0);
  const availableWidth = Math.max(0, windowWidth - left - right);
  const wide = availableWidth >= MASTER_DETAIL_MIN_WIDTH;
  if (!wide) return { availableWidth, detailWidth: availableWidth, listWidth: availableWidth, wide };

  const widthForDetail = Math.max(MASTER_DETAIL_LIST_MIN_WIDTH, availableWidth - MASTER_DETAIL_DETAIL_MIN_WIDTH);
  const listWidth = Math.min(
    MASTER_DETAIL_LIST_MAX_WIDTH,
    widthForDetail,
    Math.max(MASTER_DETAIL_LIST_MIN_WIDTH, Math.round(availableWidth * 0.36)),
  );
  return {
    availableWidth,
    detailWidth: Math.max(0, availableWidth - listWidth - StyleSheet.hairlineWidth),
    listWidth,
    wide,
  };
}

export function useMasterDetailLayout() {
  const { width } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext);
  return useMemo(
    () => masterDetailMetrics(width, { left: insets?.left ?? 0, right: insets?.right ?? 0 }),
    [insets?.left, insets?.right, width],
  );
}

export function MasterDetailLayout({
  detail,
  emptyDetail,
  list,
  testID = 'master-detail-layout',
}: {
  detail?: ReactNode;
  emptyDetail?: ReactNode;
  list: ReactNode;
  testID?: string;
}) {
  const { colors } = useMobileTheme();
  const insets = useContext(SafeAreaInsetsContext);
  const metrics = useMasterDetailLayout();
  return <View
    collapsable={false}
    style={[
      styles.root,
      metrics.wide && styles.split,
      metrics.wide && {
        paddingLeft: Math.max(0, insets?.left ?? 0),
        paddingRight: Math.max(0, insets?.right ?? 0),
      },
    ]}
    testID={testID}
  >
    <View
      style={[styles.listPane, { backgroundColor: colors.background }, metrics.wide ? { width: metrics.listWidth } : styles.compactPane]}
      testID={`${testID}-list`}
    >
      <AdaptiveContentWidthProvider availableWidth={metrics.wide ? metrics.listWidth : undefined}>{list}</AdaptiveContentWidthProvider>
    </View>
    {metrics.wide ? <>
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <View style={[styles.detailPane, { backgroundColor: colors.background }]} testID={`${testID}-detail`}>
        <AdaptiveContentWidthProvider availableWidth={metrics.detailWidth}>{detail ?? emptyDetail}</AdaptiveContentWidthProvider>
      </View>
    </> : null}
  </View>;
}

export function MasterDetailEmptyState({ icon, message, testID }: { icon: IconName; message: string; testID?: string }) {
  const { colors } = useMobileTheme();
  return <View style={[styles.empty, { backgroundColor: colors.background }]} testID={testID}>
    <EmptyState icon={icon} message={message} style={styles.emptyState} />
  </View>;
}

/** Android hardware back clears the selected wide detail before leaving the tab. */
export function useMasterDetailBack(wide: boolean, hasSelection: boolean, clearSelection: () => void) {
  useEffect(() => {
    if (!wide || !hasSelection) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      clearSelection();
      return true;
    });
    return () => subscription.remove();
  }, [clearSelection, hasSelection, wide]);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  split: { flex: 1, flexDirection: 'row' },
  compactPane: { flex: 1 },
  listPane: { overflow: 'hidden' },
  detailPane: { flex: 1, overflow: 'hidden' },
  divider: { width: StyleSheet.hairlineWidth },
  empty: { flex: 1 },
  emptyState: { flex: 1 },
});
