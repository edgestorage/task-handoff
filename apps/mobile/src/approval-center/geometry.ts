import type { AdaptiveHorizontalInsets } from '../components/adaptive-layout';

export const APPROVAL_CENTER_FAB_SIZE = 44;
export const APPROVAL_CENTER_EDGE_VISIBLE_SIZE = 22;
export const APPROVAL_CENTER_GAP = 10;
export const APPROVAL_CENTER_EDGE_HIDE_DISTANCE = 24;
export const APPROVAL_CENTER_EDGE_HIDE_VELOCITY_PX_PER_MS = 0.8;

const HORIZONTAL_MARGIN = 16;
const VERTICAL_MARGIN = 8;

export type ApprovalCenterDockSide = 'left' | 'right';
export type ApprovalCenterVisibility = 'docked' | 'edge-hidden';

export type ApprovalCenterFabPlacement = {
  dockSide: ApprovalCenterDockSide;
  verticalRatio: number;
  visibility: ApprovalCenterVisibility;
};

export const DEFAULT_APPROVAL_CENTER_PLACEMENT: ApprovalCenterFabPlacement = {
  dockSide: 'right',
  verticalRatio: 1,
  visibility: 'docked',
};

export type ApprovalCenterBounds = {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
};

export type ApprovalCenterPanelLayout = {
  bottom?: number;
  left?: number;
  maxHeight: number;
  right?: number;
  top?: number;
  width: number;
};

export function clampApprovalCenter(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function floatingTabBarOffset(platform: string) {
  return platform === 'android' ? 88 : 56;
}

export function approvalCenterHeaderFallback(platform: string, topInset: number) {
  return Math.max(0, topInset) + (platform === 'ios' ? 96 : 56);
}

export function resistedApprovalCenterDrag(value: number, min: number, max: number) {
  if (value < min) return min - Math.min(12, (min - value) * 0.25);
  if (value > max) return max + Math.min(12, (value - max) * 0.25);
  return value;
}

export function resolveApprovalCenterDrop(input: {
  bounds: ApprovalCenterBounds;
  velocityX: number;
  x: number;
  y: number;
}): ApprovalCenterFabPlacement {
  const midpoint = input.bounds.minX + (input.bounds.maxX - input.bounds.minX) / 2;
  const leftOvershoot = input.bounds.minX - input.x;
  const rightOvershoot = input.x - input.bounds.maxX;
  const leftFling = input.x <= input.bounds.minX + 8 && input.velocityX <= -APPROVAL_CENTER_EDGE_HIDE_VELOCITY_PX_PER_MS;
  const rightFling = input.x >= input.bounds.maxX - 8 && input.velocityX >= APPROVAL_CENTER_EDGE_HIDE_VELOCITY_PX_PER_MS;
  const hideLeft = leftOvershoot >= APPROVAL_CENTER_EDGE_HIDE_DISTANCE || leftFling;
  const hideRight = rightOvershoot >= APPROVAL_CENTER_EDGE_HIDE_DISTANCE || rightFling;
  const dockSide = hideLeft ? 'left' : hideRight ? 'right' : input.x <= midpoint ? 'left' : 'right';
  const height = input.bounds.maxY - input.bounds.minY;
  return {
    dockSide,
    verticalRatio: height > 0 ? clampApprovalCenter((input.y - input.bounds.minY) / height, 0, 1) : 1,
    visibility: hideLeft || hideRight ? 'edge-hidden' : 'docked',
  };
}

export function mobileApprovalCenterLayout(input: {
  adaptiveInsets: AdaptiveHorizontalInsets;
  bottomInset: number;
  contentWidth: number;
  headerHeight: number;
  obstructionHeight: number;
  placement?: ApprovalCenterFabPlacement;
  platform: string;
  windowHeight: number;
  windowWidth: number;
}) {
  const safeLeft = Math.max(0, input.adaptiveInsets.left);
  const safeRight = Math.max(0, input.adaptiveInsets.right);
  const placement = input.placement ?? DEFAULT_APPROVAL_CENTER_PLACEMENT;
  const tabBarReserved = Math.max(input.bottomInset, 8)
    + floatingTabBarOffset(input.platform)
    + Math.max(0, input.obstructionHeight);

  const minX = safeLeft + HORIZONTAL_MARGIN;
  const maxX = Math.max(minX, input.windowWidth - safeRight - HORIZONTAL_MARGIN - APPROVAL_CENTER_FAB_SIZE);
  const minY = Math.max(0, input.headerHeight) + VERTICAL_MARGIN;
  const maxY = Math.max(
    minY,
    input.windowHeight - tabBarReserved - VERTICAL_MARGIN - APPROVAL_CENTER_FAB_SIZE,
  );
  const bounds = { maxX, maxY, minX, minY };
  const verticalRatio = clampApprovalCenter(placement.verticalRatio, 0, 1);
  const y = minY + verticalRatio * (maxY - minY);
  const visibleX = placement.dockSide === 'left' ? minX : maxX;
  const hiddenX = {
    left: safeLeft - APPROVAL_CENTER_FAB_SIZE + APPROVAL_CENTER_EDGE_VISIBLE_SIZE,
    right: input.windowWidth - safeRight - APPROVAL_CENTER_EDGE_VISIBLE_SIZE,
  };
  const fabX = placement.visibility === 'edge-hidden' ? hiddenX[placement.dockSide] : visibleX;

  const panelWidth = Math.max(0, Math.min(380, input.contentWidth - HORIZONTAL_MARGIN * 2));
  const contentBottom = input.windowHeight - tabBarReserved - VERTICAL_MARGIN;
  const above = y - minY - APPROVAL_CENTER_GAP;
  const below = contentBottom - (y + APPROVAL_CENTER_FAB_SIZE) - APPROVAL_CENTER_GAP;
  const placeAbove = above >= below;
  const availablePanelHeight = Math.max(0, placeAbove ? above : below);
  const horizontalPanelStyle = placement.dockSide === 'left'
    ? { left: safeLeft + HORIZONTAL_MARGIN }
    : { right: safeRight + HORIZONTAL_MARGIN };

  const panel: ApprovalCenterPanelLayout = {
    ...horizontalPanelStyle,
    ...(placeAbove ? { bottom: input.windowHeight - (y - APPROVAL_CENTER_GAP) } : { top: y + APPROVAL_CENTER_FAB_SIZE + APPROVAL_CENTER_GAP }),
    maxHeight: Math.min(560, availablePanelHeight),
    width: panelWidth,
  };

  return {
    bounds,
    fab: { x: fabX, y },
    hiddenX,
    panel,
    panelPlacement: placeAbove ? 'above' as const : 'below' as const,
    tabBarReserved,
  };
}
