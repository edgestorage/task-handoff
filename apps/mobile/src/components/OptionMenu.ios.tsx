import { Alert } from 'react-native';

import type { AnchoredSelectMenuProps, AnchoredSelectOption } from './anchored-select-menu-types';

export type OptionMenuOption<Value extends string> = AnchoredSelectOption<Value>;
export type OptionMenuProps<Value extends string> = AnchoredSelectMenuProps<Value>;

/** iOS keeps the system alert list for these preference rows. */
export function OptionMenu<Value extends string>(props: OptionMenuProps<Value>) {
  return props.children(() => Alert.alert(props.title, undefined, [
    ...props.options.map((option) => ({
      onPress: () => props.onSelect(option.value),
      style: option.danger ? 'destructive' as const : 'default' as const,
      text: `${option.value === props.selectedValue ? '\u2713 ' : ''}${option.label}`,
    })),
    { style: 'cancel' as const, text: props.cancelLabel },
  ]));
}
