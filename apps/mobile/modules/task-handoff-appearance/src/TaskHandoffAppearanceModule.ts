import { requireOptionalNativeModule } from 'expo';

export type ApplicationNightMode = 'system' | 'light' | 'dark';

type NativeAppearanceModule = {
  setApplicationNightMode(preference: ApplicationNightMode): boolean;
};

const native = requireOptionalNativeModule<NativeAppearanceModule>('TaskHandoffAppearance');

/**
 * Persists the app-level night mode on Android 12+ so the operating system applies the in-app
 * appearance preference to configuration-derived surfaces, including the cold-start splash
 * window. Returns false when the running platform has no application night mode support.
 */
export function setApplicationNightMode(preference: ApplicationNightMode): boolean {
  try {
    return native?.setApplicationNightMode(preference) ?? false;
  } catch {
    return false;
  }
}
