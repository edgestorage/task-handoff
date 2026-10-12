import { SymbolView } from 'expo-symbols';
import type { AndroidSymbol } from 'expo-symbols';

/** Material Symbol used inside the Android floating menus. */
export function MenuIcon({ color, size = 20, symbol }: { color: string; size?: number; symbol: AndroidSymbol }) {
  return <SymbolView name={{ android: symbol }} size={size} tintColor={color} weight="medium" />;
}
