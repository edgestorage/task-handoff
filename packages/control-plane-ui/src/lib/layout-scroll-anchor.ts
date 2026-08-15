export interface LayoutAnchorViewport {
  scrollTop: number;
}

export interface LayoutAnchorElement {
  getBoundingClientRect: () => Pick<DOMRect, "top">;
}

export interface UserLayoutScrollAnchorOptions {
  cancelFrame?: (handle: number) => void;
  maxFrames?: number;
  onActiveChange?: (active: boolean) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  stableFrames?: number;
}

export function createLayoutScrollAnchor(
  getViewport: () => LayoutAnchorViewport | undefined,
  getAnchor: () => LayoutAnchorElement | undefined,
  shouldPreserve: () => boolean,
) {
  let anchorTop: number | undefined;

  function begin() {
    if (anchorTop !== undefined || !shouldPreserve()) return;
    const viewport = getViewport();
    const anchor = getAnchor();
    if (!viewport || !anchor) return;
    anchorTop = anchor.getBoundingClientRect().top;
  }

  function commit() {
    const before = anchorTop;
    anchorTop = undefined;
    if (before === undefined || !shouldPreserve()) return;
    const viewport = getViewport();
    const anchor = getAnchor();
    if (!viewport || !anchor) return;
    const adjustment = anchor.getBoundingClientRect().top - before;
    if (Math.abs(adjustment) > 0.25) viewport.scrollTop += adjustment;
  }

  function cancel() {
    anchorTop = undefined;
  }

  return { begin, cancel, commit };
}

export function createUserLayoutScrollAnchor(
  getViewport: () => LayoutAnchorViewport | undefined,
  options: UserLayoutScrollAnchorOptions = {},
) {
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const maxFrames = options.maxFrames ?? 12;
  const stableFrames = options.stableFrames ?? 3;
  let anchor: LayoutAnchorElement | undefined;
  let anchorTop = 0;
  let frame: number | undefined;
  let attempts = 0;
  let stable = 0;

  function finish() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    const wasActive = Boolean(anchor);
    anchor = undefined;
    attempts = 0;
    stable = 0;
    if (wasActive) options.onActiveChange?.(false);
  }

  function settle() {
    frame = undefined;
    const viewport = getViewport();
    const currentAnchor = anchor;
    if (!viewport || !currentAnchor) {
      finish();
      return;
    }
    const delta = currentAnchor.getBoundingClientRect().top - anchorTop;
    if (Math.abs(delta) > 0.25) viewport.scrollTop += delta;
    const residual = currentAnchor.getBoundingClientRect().top - anchorTop;
    stable = Math.abs(residual) <= 0.25 ? stable + 1 : 0;
    attempts += 1;
    if (stable >= stableFrames || attempts >= maxFrames) {
      finish();
      return;
    }
    frame = requestFrame(settle);
  }

  function begin(nextAnchor: LayoutAnchorElement) {
    finish();
    anchor = nextAnchor;
    anchorTop = nextAnchor.getBoundingClientRect().top;
    options.onActiveChange?.(true);
    frame = requestFrame(settle);
  }

  return {
    begin,
    cancel: finish,
    isActive: () => Boolean(anchor),
  };
}
