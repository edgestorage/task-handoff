import { MenuView, type MenuAction } from '@react-native-menu/menu';
import type { ColorValue } from 'react-native';

import type { AnchoredSelectMenuProps, AnchoredSelectOption } from '../components/anchored-select-menu-types';
import { useMobileTheme } from '../components/theme';

type NewSessionMenuColors = {
  image: ColorValue;
  destructiveImage: ColorValue;
};

export function newSessionMenuActions<Value extends string>(options: AnchoredSelectOption<Value>[], selectedValue: Value, colors: NewSessionMenuColors): MenuAction[] {
  return options.map((option) => ({
    attributes: option.danger ? { destructive: true } : undefined,
    id: option.value,
    image: option.systemImage,
    imageColor: option.systemImage ? (option.danger ? colors.destructiveImage : colors.image) : undefined,
    state: option.value === selectedValue ? 'on' : 'off',
    subtitle: option.description,
    title: option.label,
  }));
}

export function NewSessionContextMenu<Value extends string>(props: AnchoredSelectMenuProps<Value>) {
  const { colors } = useMobileTheme();
  if (props.disabled || props.options.length === 0) return props.children();

  const actions = newSessionMenuActions(props.options, props.selectedValue, {
    destructiveImage: colors.error,
    image: colors.textMuted,
  });

  return <MenuView
    actions={actions}
    onPressAction={(event) => props.onSelect(event.nativeEvent.event as Value)}
    title={props.title}
  >
    {props.children()}
  </MenuView>;
}
