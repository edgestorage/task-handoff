import { Children, isValidElement, type ReactElement, type Ref } from 'react';
import type { MenuComponentProps, MenuComponentRef } from '@expo/ui/community/menu';

import { FloatingMenuTrigger } from './menu/FloatingMenuTrigger';
import { menuPageFromActions } from './menu/menu-actions';

export type { MenuAction, MenuAttributes, MenuComponentProps, MenuComponentRef, MenuState, NativeActionEvent } from '@expo/ui/community/menu';

/**
 * Drop-in replacement for `@expo/ui/community/menu`'s Android implementation.
 *
 * The `@expo/ui` version renders a Material `DropdownMenu`, which loses the iOS-style
 * title section, icons, checkmarks and subtitles, and could not be opened at all from a
 * trigger that contains its own `Pressable`. Android now renders the same floating card
 * the iOS builds get from SwiftUI; iOS keeps the native menu.
 */
export function MenuView({ actions, children, onCloseMenu, onOpenMenu, onPressAction, ref, shouldOpenOnLongPress, style, testID, title }: MenuComponentProps & { ref?: Ref<MenuComponentRef> }) {
  // Long-press triggers inject their handler into the trigger element, so keep a single
  // element child instead of wrapping it in a fragment.
  const trigger: ReactElement = Children.count(children) === 1 && isValidElement(children) ? children : <>{children}</>;
  return <FloatingMenuTrigger
    disabled={actions.length === 0}
    longPress={shouldOpenOnLongPress}
    onClose={onCloseMenu}
    onOpen={onOpenMenu}
    page={menuPageFromActions(actions, title, (action) => onPressAction?.({ nativeEvent: { event: action.id ?? action.title } }))}
    ref={ref}
    style={style}
    testID={testID}
  >{() => trigger}</FloatingMenuTrigger>;
}
