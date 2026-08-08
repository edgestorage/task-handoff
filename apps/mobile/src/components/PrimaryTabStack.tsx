import { Stack } from 'expo-router';
import { Platform, Pressable } from 'react-native';

import { SystemIcon } from './SystemIcon';
import { iosTransparentHeaderOptions } from './navigation-header';
import { useMobileTheme } from './theme';
import { InstanceScopeHeaderButton } from '../instance-scope/InstanceScopeHeaderButton';

export function PrimaryTabStack({
  title,
  addAccessibilityLabel,
  onAdd,
}: {
  title: string;
  addAccessibilityLabel?: string;
  onAdd?(): void;
}) {
  const { colors, dark } = useMobileTheme();
  const scopeButton = <InstanceScopeHeaderButton />;
  const addItem = addAccessibilityLabel && onAdd ? {
    accessibilityLabel: addAccessibilityLabel,
    icon: { name: 'plus' as const, type: 'sfSymbol' as const },
    label: addAccessibilityLabel,
    onPress: onAdd,
    type: 'button' as const,
  } : undefined;
  return <Stack screenOptions={{
    contentStyle: { backgroundColor: colors.background },
    headerShadowVisible: false,
    headerTintColor: colors.primary,
    headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: '600' },
    title,
    ...(Platform.OS === 'ios' ? {
      headerLargeStyle: { backgroundColor: 'transparent' },
      headerLargeTitle: true,
      headerLargeTitleShadowVisible: true,
      ...iosTransparentHeaderOptions(dark),
      headerLeft: () => scopeButton,
      ...(addItem ? { unstable_headerRightItems: () => [addItem] } : undefined),
    } : {
      headerStyle: { backgroundColor: colors.surface },
      headerLeft: () => scopeButton,
      ...(addItem ? { headerRight: () => <Pressable accessibilityLabel={addAccessibilityLabel} accessibilityRole="button" hitSlop={10} onPress={onAdd}><SystemIcon android="add" color={colors.primary} ios="plus" size={20} /></Pressable> } : undefined),
    }),
  }} />;
}
