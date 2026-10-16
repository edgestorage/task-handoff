import type { IconName } from '../components/Icon';

const TERMINAL_APP_IDS = new Set(['terminal', 'terminal-tty', 'gui-terminal']);

export function appLaunchIcon(appId?: string): IconName {
  if (appId === 'codex' || appId === 'claude') return 'sparkles';
  if (appId && TERMINAL_APP_IDS.has(appId)) return 'terminal-outline';
  if (appId === 'embedded-browser') return 'globe-outline';
  return 'play';
}
