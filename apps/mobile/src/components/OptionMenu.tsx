import type { AnchoredSelectMenuProps, AnchoredSelectOption } from './anchored-select-menu-types';
import { AnchoredSelectMenu } from './AnchoredSelectMenu';

export type OptionMenuOption<Value extends string> = AnchoredSelectOption<Value>;
export type OptionMenuProps<Value extends string> = AnchoredSelectMenuProps<Value>;

/**
 * Settings-style single-select row menu. Android opens the floating iOS-style card;
 * iOS keeps the system alert it has always used (see `OptionMenu.ios.tsx`).
 */
export function OptionMenu<Value extends string>(props: OptionMenuProps<Value>) {
  return <AnchoredSelectMenu {...props} />;
}
