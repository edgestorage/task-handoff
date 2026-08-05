import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import type { StyleProp, ViewStyle } from 'react-native';

export function SystemIcon({
  android,
  color,
  ios,
  size = 20,
  style,
}: {
  android: AndroidSymbol;
  color: string;
  ios: SFSymbol;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <SymbolView name={{ android, ios }} resizeMode="scaleAspectFit" size={size} style={style} tintColor={color} weight="medium" />;
}
