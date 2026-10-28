import { useNavigation, type NativeStackHeaderItem, type NativeStackNavigationOptions } from 'expo-router';
import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';

/** Applies detail-screen navigation options to a pane-owned native stack. */
export function EmbeddedPaneHeaderOptions({
  enabled,
  headerRight,
  headerRightItems,
  title,
}: {
  enabled: boolean;
  headerRight?: ReactNode;
  headerRightItems?: () => NativeStackHeaderItem[];
  title: string;
}) {
  const navigation = useNavigation();
  const headerRightRef = useRef(headerRight);
  const headerRightItemsRef = useRef(headerRightItems);
  useLayoutEffect(() => {
    headerRightRef.current = headerRight;
    headerRightItemsRef.current = headerRightItems;
  });
  const renderHeaderRight = useCallback(() => headerRightRef.current ?? null, []);
  const renderHeaderRightItems = useCallback(() => headerRightItemsRef.current?.() ?? [], []);
  const hasHeaderRight = Boolean(headerRight);
  const hasHeaderRightItems = Boolean(headerRightItems);
  useLayoutEffect(() => {
    if (!enabled) return;
    const options: NativeStackNavigationOptions = { title };
    if (hasHeaderRightItems) options.unstable_headerRightItems = renderHeaderRightItems;
    if (hasHeaderRight) options.headerRight = renderHeaderRight;
    if (!hasHeaderRight && !hasHeaderRightItems) {
      options.headerRight = undefined;
      options.unstable_headerRightItems = undefined;
    }
    navigation.setOptions(options);
  }, [enabled, hasHeaderRight, hasHeaderRightItems, navigation, renderHeaderRight, renderHeaderRightItems, title]);
  return null;
}
