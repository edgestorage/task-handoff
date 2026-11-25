import { FlatList, View } from 'react-native';

import {
  adaptiveContentContainerStyle,
  useAdaptiveContentLayout,
} from './adaptive-layout';
import { SwipeActions } from './SwipeActions';
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
  swipeActions,
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
      const content = renderItem(info);
      const containerStyle = typeof itemContainerStyle === 'function' ? itemContainerStyle(info.item, info.index) : itemContainerStyle;
      const singleAction = swipeAction?.(info.item);
      const actions = swipeActions ? swipeActions(info.item) : singleAction ? [singleAction] : [];
      if (!actions?.length) return <View style={containerStyle}>{content}</View>;
      return <SwipeActions actions={actions} containerStyle={containerStyle}>{content}</SwipeActions>;
    }}
    style={style}
    testID="swipe-action-list"
  />;
}

export type { SwipeAction, SwipeActionListProps } from './SwipeActionList.types';
