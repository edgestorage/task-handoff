import type { AndroidSymbol } from 'expo-symbols';

type AppLaunchSFSymbol = 'sparkles' | 'terminal' | 'globe' | 'play.fill';

export type AppLaunchSystemIcon = {
  android: AndroidSymbol;
  ios: AppLaunchSFSymbol;
};

const TERMINAL_APP_IDS = new Set(['terminal', 'terminal-tty', 'gui-terminal']);

export function appLaunchSystemIcon(appId?: string): AppLaunchSystemIcon {
  if (appId === 'codex' || appId === 'claude') return { android: 'auto_awesome', ios: 'sparkles' };
  if (appId && TERMINAL_APP_IDS.has(appId)) return { android: 'terminal', ios: 'terminal' };
  if (appId === 'embedded-browser') return { android: 'language', ios: 'globe' };
  return { android: 'play_arrow', ios: 'play.fill' };
}
