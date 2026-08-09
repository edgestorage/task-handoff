import { Alert } from 'react-native';

import type { AnchoredSelectMenuProps } from './anchored-select-menu-types';

export type { AnchoredSelectOption } from './anchored-select-menu-types';

export function AnchoredSelectMenu<Value extends string>(props: AnchoredSelectMenuProps<Value>) {
  return props.children(() => Alert.alert(props.title, undefined, [
    ...props.options.map((option) => ({
      text: option.label,
      style: option.danger ? 'destructive' as const : 'default' as const,
      onPress: () => props.onSelect(option.value),
    })),
    { text: props.cancelLabel, style: 'cancel' },
  ]));
}
