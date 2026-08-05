import { FlatList, type FlatListProps } from 'react-native';

type ScreenFlatListProps<ItemT> = Omit<FlatListProps<ItemT>, 'contentInsetAdjustmentBehavior'>;

export function ScreenFlatList<ItemT>(props: ScreenFlatListProps<ItemT>) {
  return <FlatList {...props} contentInsetAdjustmentBehavior="automatic" />;
}
