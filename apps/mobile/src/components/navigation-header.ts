import { Platform } from 'react-native';

export function iosTransparentHeaderOptions(dark: boolean) {
  if (Platform.OS !== 'ios') return undefined;

  const iosMajorVersion = Number.parseInt(String(Platform.Version), 10);

  if (iosMajorVersion >= 27) {
    return {
      headerShadowVisible: false,
      headerStyle: { backgroundColor: 'transparent' },
      headerTransparent: true,
      // UIKit 27 changed the automatic treatment. Native SwiftUI lists, including the
      // instances screen, use it and no longer match an explicitly pinned iOS 26 soft edge.
      scrollEdgeEffects: { top: 'automatic' as const },
    } as const;
  }

  if (iosMajorVersion >= 26) {
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
