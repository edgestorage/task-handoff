import type { AndroidSymbol } from 'expo-symbols';
import type { ImageSourcePropType } from 'react-native';

/**
 * Platform-neutral description of a floating (iOS style) menu. Android renders it
 * with `FloatingMenu`; iOS keeps using the native SwiftUI/UIKit menus.
 */
export type FloatingMenuItem = {
  key: string;
  label: string;
  subtitle?: string;
  icon?: AndroidSymbol;
  iconSource?: ImageSourcePropType;
  iconColor?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Renders a leading checkmark instead of the icon. */
  selected?: boolean;
  /** Opens a nested page inside the same card and shows a trailing chevron. */
  submenu?: FloatingMenuPage;
  onPress?(): void;
};

export type FloatingMenuBlock =
  /** Bold menu title, like SwiftUI `Menu(title:)`. */
  | { type: 'title'; key: string; label: string }
  /** Muted group label above a group of items. */
  | { type: 'section'; key: string; label: string }
  | { type: 'divider'; key: string }
  | { type: 'item'; key: string; item: FloatingMenuItem };

export type FloatingMenuPage = {
  /** Title shown above a nested page. */
  title?: string;
  blocks: FloatingMenuBlock[];
};

export function floatingMenuHasLeadingIcon(blocks: FloatingMenuBlock[]) {
  return blocks.some((block) => block.type === 'item' && Boolean(block.item.icon || block.item.iconSource || block.item.selected));
}
