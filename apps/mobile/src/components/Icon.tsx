import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import type { StyleProp, TextStyle } from 'react-native';

/**
 * The app renders every icon from the Ionicons set on both platforms so the same
 * view looks identical on iOS and Android. Native-only surfaces (SwiftUI menus,
 * buttons, lists) keep their own SF Symbols, see `sf-symbols.ts`.
 */
export type IconName = ComponentProps<typeof Ionicons>['name'];

export function Icon({ color, name, size = 20, style, testID }: { color: string; name: IconName; size?: number; style?: StyleProp<TextStyle>; testID?: string }) {
  return <Ionicons accessibilityElementsHidden accessible={false} aria-hidden color={color} importantForAccessibility="no-hide-descendants" name={name} size={size} style={style} testID={testID} />;
}
