import { FlatList, type FlatListProps } from 'react-native';

import {
  adaptiveContentContainerStyle,
  useAdaptiveContentLayout,
} from './adaptive-layout';

type ScreenFlatListProps<ItemT> = Omit<FlatListProps<ItemT>, 'contentInsetAdjustmentBehavior'>;

export function ScreenFlatList<ItemT>(props: ScreenFlatListProps<ItemT>) {
  const adaptive = useAdaptiveContentLayout();
  return <FlatList
    {...props}
    contentContainerStyle={adaptiveContentContainerStyle(props.contentContainerStyle, adaptive.contentInsets)}
    contentInsetAdjustmentBehavior="automatic"
    scrollIndicatorInsets={props.scrollIndicatorInsets ?? adaptive.scrollIndicatorInsets}
    style={props.style}
  />;
}
