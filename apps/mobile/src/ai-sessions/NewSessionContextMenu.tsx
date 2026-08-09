import { AnchoredSelectMenu } from '../components/AnchoredSelectMenu';
import type { AnchoredSelectMenuProps } from '../components/anchored-select-menu-types';

export function NewSessionContextMenu<Value extends string>(props: AnchoredSelectMenuProps<Value>) {
  return <AnchoredSelectMenu {...props} />;
}
