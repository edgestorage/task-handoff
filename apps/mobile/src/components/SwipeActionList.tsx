import { FlatList, View } from 'react-native';

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
  return <FlatList
    contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={contentContainerStyle}
    data={data}
    keyExtractor={keyExtractor}
    ListEmptyComponent={ListEmptyComponent}
    ListHeaderComponent={ListHeaderComponent == null ? null : <>{ListHeaderComponent}</>}
    onRefresh={onRefresh}
    refreshing={refreshing}
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
