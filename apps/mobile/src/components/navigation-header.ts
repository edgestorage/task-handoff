import { Platform } from 'react-native';

export function iosTransparentHeaderOptions(dark: boolean) {
  if (Platform.OS !== 'ios') return undefined;

  if (Number.parseInt(String(Platform.Version), 10) >= 26) {
    return {
      headerShadowVisible: false,
      headerStyle: { backgroundColor: 'transparent' },
      headerTransparent: true,
      scrollEdgeEffects: { top: 'soft' as const },
    } as const;
  }

  return {
    headerBlurEffect: dark ? 'systemUltraThinMaterialDark' as const : 'systemUltraThinMaterialLight' as const,
    headerShadowVisible: true,
    headerStyle: { backgroundColor: 'transparent' },
    headerTransparent: true,
  } as const;
}
