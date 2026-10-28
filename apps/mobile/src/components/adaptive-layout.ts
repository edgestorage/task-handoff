import { createContext, createElement, useContext, useMemo, type PropsWithChildren } from 'react';
import {
  StyleSheet,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

/** Width at which a phone-sized layout starts benefiting from extra horizontal room. */
export const REGULAR_LAYOUT_MIN_WIDTH = 700;
export const ADAPTIVE_CONTENT_MAX_WIDTH = 840;
export const ADAPTIVE_READING_MAX_WIDTH = 780;

type AdaptiveContentContextValue = {
  availableWidth?: number;
  horizontalInsets?: Partial<AdaptiveHorizontalInsets>;
};

const AdaptiveContentWidthContext = createContext<AdaptiveContentContextValue | undefined>(undefined);

export type AdaptiveHorizontalInsets = {
  left: number;
  right: number;
};

export type AdaptiveContentLayout = {
  contentInsets: AdaptiveHorizontalInsets;
  contentStyle: ViewStyle | undefined;
  contentWidth: number;
  regular: boolean;
  scrollIndicatorInsets: AdaptiveScrollIndicatorInsets | undefined;
};

export type AdaptiveScrollIndicatorInsets = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export function adaptiveContentWidth(availableWidth: number, maxWidth = ADAPTIVE_CONTENT_MAX_WIDTH) {
  if (!Number.isFinite(availableWidth) || availableWidth < REGULAR_LAYOUT_MIN_WIDTH) return undefined;
  return Math.max(0, Math.min(maxWidth, availableWidth));
}

export function adaptiveContentLayout(
  availableWidth: number,
  maxWidth = ADAPTIVE_CONTENT_MAX_WIDTH,
  safeAreaInsets: Partial<AdaptiveHorizontalInsets> = {},
): AdaptiveContentLayout {
  const left = Math.max(0, safeAreaInsets.left ?? 0);
  const right = Math.max(0, safeAreaInsets.right ?? 0);
  const usableWidth = Math.max(0, availableWidth - left - right);
  const width = adaptiveContentWidth(usableWidth, maxWidth);
  const contentWidth = width ?? usableWidth;
  const centeringInset = width === undefined ? 0 : Math.max(0, (usableWidth - width) / 2);
  const contentInsets = { left: left + centeringInset, right: right + centeringInset };
  const resolvedSafeAreaInsets = { left, right };
  return {
    contentInsets,
    contentStyle: contentInsets.left || contentInsets.right
      ? { marginLeft: contentInsets.left, marginRight: contentInsets.right }
      : undefined,
    contentWidth,
    regular: width !== undefined,
    scrollIndicatorInsets: adaptiveScrollIndicatorInsets(contentInsets, resolvedSafeAreaInsets),
  };
}

export function adaptiveContentStyle(
  availableWidth: number,
  maxWidth = ADAPTIVE_CONTENT_MAX_WIDTH,
  safeAreaInsets: Partial<AdaptiveHorizontalInsets> = {},
) {
  return adaptiveContentLayout(availableWidth, maxWidth, safeAreaInsets).contentStyle;
}

function horizontalPadding(value: unknown) {
  return typeof value === 'number' ? value : 0;
}

/**
 * Keeps a scroll view full width so iOS can render its navigation-bar scroll edge
 * effect across the whole window. The bounded column is applied to the scroll
 * content instead of shrinking the viewport.
 */
export function adaptiveContentContainerStyle(
  baseStyle: StyleProp<ViewStyle>,
  contentInsets: AdaptiveHorizontalInsets,
): StyleProp<ViewStyle> {
  if (!contentInsets.left && !contentInsets.right) return baseStyle;
  const base = StyleSheet.flatten(baseStyle) ?? {};
  const baseLeft = horizontalPadding(base.paddingLeft ?? base.paddingHorizontal ?? base.padding);
  const baseRight = horizontalPadding(base.paddingRight ?? base.paddingHorizontal ?? base.padding);
  return [baseStyle, {
    paddingLeft: baseLeft + contentInsets.left,
    paddingRight: baseRight + contentInsets.right,
  }];
}

export function adaptiveScrollIndicatorInsets(
  contentInsets: AdaptiveHorizontalInsets,
  safeAreaInsets: Partial<AdaptiveHorizontalInsets> = {},
): AdaptiveScrollIndicatorInsets | undefined {
  const left = Math.max(0, contentInsets.left - Math.max(0, safeAreaInsets.left ?? 0));
  const right = Math.max(0, contentInsets.right - Math.max(0, safeAreaInsets.right ?? 0));
  if (!left && !right) return undefined;
  return {
    bottom: 0,
    left,
    right,
    top: 0,
  };
}

/**
 * Gives adaptive content its nearest pane width. A master-detail pane is
 * already positioned inside the horizontal safe area, so its children must
 * not apply the window safe area a second time.
 */
export function AdaptiveContentWidthProvider({
  availableWidth,
  children,
  horizontalInsets,
}: PropsWithChildren<{
  availableWidth?: number;
  horizontalInsets?: Partial<AdaptiveHorizontalInsets>;
}>) {
  const value = useMemo(
    () => availableWidth === undefined && horizontalInsets === undefined
      ? undefined
      : { availableWidth, horizontalInsets },
    [availableWidth, horizontalInsets],
  );
  return createElement(AdaptiveContentWidthContext.Provider, { value }, children);
}

export function useAdaptiveContentLayout(maxWidth = ADAPTIVE_CONTENT_MAX_WIDTH) {
  const { width } = useWindowDimensions();
  const safeAreaInsets = useContext(SafeAreaInsetsContext);
  const pane = useContext(AdaptiveContentWidthContext);
  return useMemo(
    () => adaptiveContentLayout(
      pane?.availableWidth ?? width,
      maxWidth,
      pane ? pane.horizontalInsets ?? {} : safeAreaInsets ?? {},
    ),
    [maxWidth, pane, safeAreaInsets, width],
  );
}
