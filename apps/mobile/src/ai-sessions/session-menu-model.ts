import type { MenuAction } from '@expo/ui/community/menu';
import type { NativeStackHeaderItemMenuAction, NativeStackHeaderItemMenuSubmenu } from 'expo-router';

export type SessionMenuSymbol = Extract<NonNullable<MenuAction['image']>, string>;

export type SessionMenuAction = {
  id: string;
  label: string;
  symbol: SessionMenuSymbol;
  disabled?: boolean;
  destructive?: boolean;
  selected?: boolean;
  onPress(): void;
};

export type SessionMenuGroup = {
  id: string;
  label: string;
  actions: SessionMenuAction[];
};

export type SessionMenuItem =
  | { type: 'action'; action: SessionMenuAction }
  | { type: 'group'; group: SessionMenuGroup };

function nativeAction(action: SessionMenuAction): NativeStackHeaderItemMenuAction {
  return {
    type: 'action',
    label: action.label,
    icon: { name: action.symbol, type: 'sfSymbol' } as NativeStackHeaderItemMenuAction['icon'],
    onPress: action.onPress,
    disabled: action.disabled,
    destructive: action.destructive,
    ...(action.selected === undefined ? {} : { state: action.selected ? 'on' as const : 'off' as const }),
  };
}

function floatingAction(action: SessionMenuAction): MenuAction {
  return {
    id: action.id,
    title: action.label,
    image: action.symbol,
    attributes: action.disabled || action.destructive ? { disabled: action.disabled, destructive: action.destructive } : undefined,
    state: action.selected ? 'on' : 'off',
  };
}

function nativeItem(item: SessionMenuItem): NativeStackHeaderItemMenuSubmenu | NativeStackHeaderItemMenuAction {
  if (item.type === 'action') return nativeAction(item.action);
  return {
    type: 'submenu',
    label: item.group.label,
    inline: true,
    multiselectable: true,
    items: item.group.actions.map(nativeAction),
  };
}

/** iOS native header menus use SF Symbols and inline submenus as sections. */
export function nativeSessionMenuItems(items: SessionMenuItem[], footer: SessionMenuAction[] = []) {
  return [
    ...items
      .filter((item) => item.type === 'action' || item.group.actions.length > 0)
      .map(nativeItem),
    ...footer.map(nativeAction),
  ];
}

/** Android renders the same groups through the floating card menu. */
export function floatingSessionMenuActions(items: SessionMenuItem[], footer: SessionMenuAction[] = []) {
  return [
    ...items
      .filter((item) => item.type === 'action' || item.group.actions.length > 0)
      .map((item): MenuAction => item.type === 'action'
        ? floatingAction(item.action)
        : {
            id: item.group.id,
            title: item.group.label,
            displayInline: true,
            subactions: item.group.actions.map(floatingAction),
          }),
    ...footer.map(floatingAction),
  ];
}
