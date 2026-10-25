import { FlatList, View } from 'react-native';

import {
  adaptiveContentContainerStyle,
  useAdaptiveContentLayout,
} from './adaptive-layout';
import { SwipeToClose } from './SwipeToClose';
import type { SwipeActionListProps } from './SwipeActionList.types';

export function SwipeActionList<Item>({
  contentContainerStyle,
  data,
  itemContainerStyle,
  keyExtractor,
  ListEmptyComponent,
  ListHeaderComponent,
  onRefresh,
  refreshing,
  renderItem,
  style,
  swipeAction,
}: SwipeActionListProps<Item>) {
  const adaptive = useAdaptiveContentLayout();
  return <FlatList
    contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={adaptiveContentContainerStyle(contentContainerStyle, adaptive.contentInsets)}
    data={data}
    keyExtractor={keyExtractor}
    ListEmptyComponent={ListEmptyComponent}
    ListHeaderComponent={ListHeaderComponent == null ? null : <>{ListHeaderComponent}</>}
    onRefresh={onRefresh}
    refreshing={refreshing}
    scrollIndicatorInsets={adaptive.scrollIndicatorInsets}
    renderItem={(info) => {
      const action = swipeAction(info.item);
      const content = renderItem(info);
      const containerStyle = typeof itemContainerStyle === 'function' ? itemContainerStyle(info.item, info.index) : itemContainerStyle;
      if (!action) return <View style={containerStyle}>{content}</View>;
      return <SwipeToClose containerStyle={containerStyle} disabled={action.disabled} label={action.label} onClose={action.onPress}>{content}</SwipeToClose>;
    }}
    style={style}
    testID="swipe-action-list"
  />;
}

export type { SwipeAction, SwipeActionListProps } from './SwipeActionList.types';
