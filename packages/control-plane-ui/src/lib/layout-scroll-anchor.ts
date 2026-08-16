export interface LayoutAnchorViewport {
  scrollTop: number;
}

export interface LayoutAnchorElement {
  getBoundingClientRect: () => Pick<DOMRect, "top">;
}

export interface UserLayoutChangeGuardOptions {
  cancelFrame?: (handle: number) => void;
  frames?: number;
  onActiveChange?: (active: boolean) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
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

export function createUserLayoutChangeGuard(options: UserLayoutChangeGuardOptions = {}) {
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const frames = options.frames ?? 3;
  let frame: number | undefined;
  let active = false;
  let remaining = 0;

  function finish() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    remaining = 0;
    if (!active) return;
    active = false;
    options.onActiveChange?.(false);
  }

  function settle() {
    frame = undefined;
    remaining -= 1;
    if (remaining <= 0) {
      finish();
      return;
    }
    frame = requestFrame(settle);
  }

  function begin() {
    finish();
    active = true;
    remaining = frames;
    options.onActiveChange?.(true);
    frame = requestFrame(settle);
  }

  return {
    begin,
    cancel: finish,
    isActive: () => active,
  };
}
