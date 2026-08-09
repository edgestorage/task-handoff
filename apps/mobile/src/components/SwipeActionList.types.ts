import type { ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

export type SwipeAction = {
  disabled?: boolean;
  label: string;
  onPress(): void;
};

export type SwipeActionListProps<Item> = {
  contentContainerStyle?: StyleProp<ViewStyle>;
  data: readonly Item[];
  itemContainerStyle?: StyleProp<ViewStyle>;
  keyExtractor(item: Item, index: number): string;
  ListEmptyComponent?: ReactElement | null;
  ListHeaderComponent?: ReactElement | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  renderItem(info: { index: number; item: Item }): ReactElement;
  swipeAction(item: Item): SwipeAction | null;
  style?: StyleProp<ViewStyle>;
};
