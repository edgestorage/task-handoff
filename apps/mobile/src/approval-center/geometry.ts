import type { AdaptiveHorizontalInsets } from '../components/adaptive-layout';

export const APPROVAL_CENTER_FAB_SIZE = 56;
export const APPROVAL_CENTER_GAP = 12;

export function floatingTabBarOffset(platform: string) {
  return platform === 'android' ? 88 : 56;
}

export function mobileApprovalCenterLayout(input: {
  adaptiveInsets: AdaptiveHorizontalInsets;
  bottomInset: number;
  contentWidth: number;
  obstructionHeight: number;
  platform: string;
  windowHeight: number;
}) {
  const right = Math.max(0, input.adaptiveInsets.right) + 16;
  const bottom = Math.max(input.bottomInset, 8)
    + floatingTabBarOffset(input.platform)
    + Math.max(0, input.obstructionHeight);
  const panelWidth = Math.max(0, Math.min(380, input.contentWidth - right - 16));
  const availableHeight = Math.max(0, input.windowHeight - bottom - 68 - 24);
  return {
    bottom,
    panelMaxHeight: Math.min(560, availableHeight),
    panelWidth,
    right,
  };
}
