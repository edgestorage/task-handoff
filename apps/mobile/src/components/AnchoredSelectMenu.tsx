import { useMemo } from 'react';

import type { AnchoredSelectMenuProps } from './anchored-select-menu-types';
import { androidSymbolForSfSymbol } from './menu/menu-icons';
import { FloatingMenuTrigger } from './menu/FloatingMenuTrigger';
import type { FloatingMenuBlock } from './menu/menu-model';

export type { AnchoredSelectOption } from './anchored-select-menu-types';

/**
 * Android renders the single-select menu as an iOS-style floating card (title, grouped
 * rows, leading icons, subtitles and checkmarks) instead of the system alert list.
 */
export function AnchoredSelectMenu<Value extends string>({ children, disabled, onSelect, options, selectedValue, title }: AnchoredSelectMenuProps<Value>) {
  const blocks = useMemo(() => {
    const result: FloatingMenuBlock[] = [];
    if (title) result.push({ key: 'title', label: title, type: 'title' });
    options.forEach((option, index) => {
      if (option.groupLabel && options[index - 1]?.groupLabel !== option.groupLabel) {
        result.push({ key: `group:${option.groupLabel}`, label: option.groupLabel, type: 'section' });
      }
      result.push({
        item: {
          destructive: option.danger,
          icon: androidSymbolForSfSymbol(option.systemImage),
          key: option.value,
          label: option.label,
          onPress: () => onSelect(option.value),
          selected: option.value === selectedValue,
          subtitle: option.description,
        },
        key: option.value,
        type: 'item',
      });
    });
    return result;
  }, [onSelect, options, selectedValue, title]);

  const unavailable = Boolean(disabled) || options.length === 0;
  return <FloatingMenuTrigger disabled={unavailable} page={unavailable ? null : { blocks, title }}>{children}</FloatingMenuTrigger>;
}
