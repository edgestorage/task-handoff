import type { ReactElement } from 'react';

export type AnchoredSelectOption<Value extends string = string> = {
  value: Value;
  label: string;
  description?: string;
  systemImage?: 'server.rack' | 'app' | 'folder' | 'arrow.triangle.branch' | 'sparkles' | 'hand.raised' | 'checkmark.shield' | 'exclamationmark.shield';
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
