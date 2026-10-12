import type { AndroidSymbol, SFSymbol } from 'expo-symbols';

/**
 * Menu actions describe their icon with an SF Symbol (used by the native iOS menus).
 * Android renders Material Symbols instead, so every SF Symbol that can show up in a
 * menu needs an Android counterpart here. Names follow the mapping already used by
 * `SystemIcon` call sites so one symbol renders identically in and out of menus.
 */
const SF_SYMBOL_TO_ANDROID: Partial<Record<SFSymbol, AndroidSymbol>> = {
  'app': 'apps',
  'archivebox': 'archive',
  'arrow.clockwise': 'refresh',
  'arrow.clockwise.circle': 'refresh',
  'arrow.clockwise.circle.fill': 'refresh',
  'arrow.triangle.branch': 'account_tree',
  'arrow.uturn.backward': 'undo',
  'bolt': 'bolt',
  'bolt.fill': 'bolt',
  'brain': 'psychology',
  'bubble.left': 'chat_bubble_outline',
  'calendar': 'schedule',
  'calendar.badge.clock': 'schedule',
  'checkmark': 'check',
  'circle.lefthalf.filled': 'dark_mode',
  'moon': 'dark_mode',
  'checkmark.shield': 'verified_user',
  'chevron.left': 'chevron_left',
  'chevron.right': 'chevron_right',
  'doc.text': 'description',
  'ellipsis': 'more_horiz',
  'exclamationmark.shield': 'gpp_maybe',
  'folder': 'folder',
  'gearshape': 'settings',
  'globe': 'language',
  'hand.raised': 'back_hand',
  'link': 'link',
  'paperclip': 'attach_file',
  'pencil': 'edit',
  'photo': 'image',
  'play.circle': 'play_circle',
  'play.fill': 'play_arrow',
  'plus.bubble': 'add_comment',
  'rectangle.stack': 'view_carousel',
  'server.rack': 'dns',
  'sparkles': 'auto_awesome',
  'stop.circle': 'stop_circle',
  'sun.max': 'light_mode',
  'terminal': 'terminal',
  'text.bubble': 'chat_bubble',
  'trash': 'delete',
  'waveform': 'graphic_eq',
  'waveform.slash': 'graphic_eq',
  'xmark.circle': 'cancel',
  'xmark.circle.fill': 'cancel',
};

export function androidSymbolForSfSymbol(symbol: string | undefined): AndroidSymbol | undefined {
  if (!symbol) return undefined;
  return SF_SYMBOL_TO_ANDROID[symbol as SFSymbol];
}
