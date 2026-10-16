import type { SFSymbol } from 'expo-symbols';

import type { IconName } from './Icon';

/**
 * Native iOS surfaces (SwiftUI menus, buttons and lists) can only draw SF Symbols.
 * Shared code names icons with the app-wide Ionicons set, so the icons that still
 * reach those native views need their SF Symbol counterpart here.
 */
const SF_SYMBOLS: Partial<Record<IconName, SFSymbol>> = {
  'arrow-forward': 'arrow.right',
  'globe-outline': 'globe',
  'log-in-outline': 'person.badge.key',
  'play': 'play.fill',
  'shield-checkmark-outline': 'checkmark.shield',
  'sparkles': 'sparkles',
  'terminal-outline': 'terminal',
};

export function sfSymbolForIcon(icon: IconName): SFSymbol | undefined {
  return SF_SYMBOLS[icon];
}
