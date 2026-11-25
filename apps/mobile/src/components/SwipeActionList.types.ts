import type { ReactElement, ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import type { IconName } from './Icon';

export type SwipeAction = {
  backgroundColor?: string;
  disabled?: boolean;
  icon?: IconName;
  label: string;
  onPress(): void;
  tone?: 'destructive' | 'primary';
};

export type SwipeActionListProps<Item> = {
  contentContainerStyle?: StyleProp<ViewStyle>;
  data: readonly Item[];
  itemContainerStyle?: StyleProp<ViewStyle> | ((item: Item, index: number) => StyleProp<ViewStyle>);
  keyExtractor(item: Item, index: number): string;
  ListEmptyComponent?: ReactElement | null;
  ListHeaderComponent?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  renderItem(info: { index: number; item: Item }): ReactElement;
  swipeAction?(item: Item): SwipeAction | null;
  swipeActions?(item: Item): readonly SwipeAction[] | null;
  style?: StyleProp<ViewStyle>;
};
