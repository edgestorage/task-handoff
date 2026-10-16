import type { IconName } from '../Icon';

/**
 * Menu actions describe their icon with an SF Symbol (used by the native iOS menus),
 * so every symbol that can show up in a menu needs its Ionicons counterpart here for
 * the Android floating menus. Names follow the mapping used by `Icon` call sites, so
 * one action renders the same glyph in and out of menus.
 */
const SF_SYMBOL_TO_ICON: Partial<Record<string, IconName>> = {
  'app': 'apps-outline',
  'archivebox': 'archive-outline',
  'arrow.clockwise': 'refresh',
  'arrow.clockwise.circle': 'refresh-circle-outline',
  'arrow.clockwise.circle.fill': 'refresh-circle',
  'arrow.triangle.branch': 'git-branch-outline',
  'arrow.uturn.backward': 'arrow-undo-outline',
  'bolt': 'flash',
  'bolt.fill': 'flash',
  'brain': 'bulb-outline',
  'bubble.left': 'chatbubble-outline',
  'calendar': 'calendar-outline',
  'calendar.badge.clock': 'time-outline',
  'checkmark': 'checkmark',
  'checkmark.shield': 'shield-checkmark-outline',
  'chevron.left': 'chevron-back',
  'chevron.right': 'chevron-forward',
  'circle.lefthalf.filled': 'contrast-outline',
  'doc.text': 'document-text-outline',
  'ellipsis': 'ellipsis-horizontal',
  'exclamationmark.shield': 'warning-outline',
  'folder': 'folder-outline',
  'gearshape': 'settings-outline',
  'globe': 'globe-outline',
  'hand.raised': 'hand-left-outline',
  'link': 'link',
  'moon': 'moon-outline',
  'paperclip': 'attach-outline',
  'pencil': 'pencil',
  'photo': 'image-outline',
  'play.circle': 'play-circle-outline',
  'play.fill': 'play',
  'plus.bubble': 'add-circle-outline',
  'rectangle.stack': 'albums-outline',
  'server.rack': 'server-outline',
  'sparkles': 'sparkles',
  'stop.circle': 'stop-circle-outline',
  'sun.max': 'sunny-outline',
  'terminal': 'terminal-outline',
  'text.bubble': 'chatbubble-outline',
  'trash': 'trash-outline',
  'waveform': 'pulse-outline',
  'waveform.slash': 'pulse-outline',
  'xmark.circle': 'close-circle-outline',
  'xmark.circle.fill': 'close-circle',
};

export function menuIconForSfSymbol(symbol: string | undefined): IconName | undefined {
  if (!symbol) return undefined;
  return SF_SYMBOL_TO_ICON[symbol];
}
