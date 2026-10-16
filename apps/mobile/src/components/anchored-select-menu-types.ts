import type { ReactElement } from 'react';
import type { SFSymbol } from 'expo-symbols';

export type AnchoredSelectOption<Value extends string = string> = {
  value: Value;
  label: string;
  groupLabel?: string;
  description?: string;
  systemImage?: SFSymbol;
  danger?: boolean;
};

export type AnchoredSelectMenuProps<Value extends string = string> = {
  title: string;
  cancelLabel: string;
  disabled?: boolean;
  selectedValue: Value;
  options: AnchoredSelectOption<Value>[];
  children(onPress?: () => void): ReactElement;
  onSelect(value: Value): void;
};
