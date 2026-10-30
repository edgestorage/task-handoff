export const APP_SESSION_TERMINAL_FONT_SIZE = 10;

/** Transparent split-pane headers overlay non-scroll App Session content. */
export function appSessionPaneTopInset(platform: string, embeddedHeader: boolean, headerHeight: number): number {
  if (platform !== 'ios' || !embeddedHeader) return 0;
  return Math.max(0, headerHeight);
}

const IOS_TERMINAL_ACCESSORY_HEIGHT = 52;
const IOS_26_TERMINAL_ACCESSORY_OUTER_PADDING = 8;
const IOS_TERMINAL_ACCESSORY_CLEARANCE = 60;

export function appSessionTerminalKeyboardBehavior(platform: string): 'height' | undefined {
  return platform === 'ios' ? 'height' : undefined;
}

export function appSessionTerminalKeyboardOffset(platform: string, version: string | number): number {
  if (platform !== 'ios') return 0;
  const majorVersion = typeof version === 'number' ? Math.trunc(version) : Number.parseInt(version, 10);
  return IOS_TERMINAL_ACCESSORY_HEIGHT
    + (majorVersion >= 26 ? IOS_26_TERMINAL_ACCESSORY_OUTER_PADDING : 0)
    + IOS_TERMINAL_ACCESSORY_CLEARANCE;
}
