export interface ScrollViewport {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface StreamingScrollFollowOptions {
  cancelFrame?: (handle: number) => void;
  onFollowingChange?: (following: boolean) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  threshold?: number;
}

export function distanceFromBottom(viewport: ScrollViewport) {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
}

export function createStreamingScrollFollow(
  getViewport: () => ScrollViewport | undefined,
  options: StreamingScrollFollowOptions = {},
) {
  const threshold = options.threshold ?? 48;
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  let following = true;
  let frame: number | undefined;

  function setFollowing(value: boolean) {
    if (following === value) return;
    following = value;
    options.onFollowingChange?.(value);
  }

  function handleScroll() {
    const viewport = getViewport();
    if (!viewport) return;
    setFollowing(distanceFromBottom(viewport) <= threshold);
  }

  function scheduleFollow() {
    if (!following || frame !== undefined) return;
    frame = requestFrame(() => {
      frame = undefined;
      const viewport = getViewport();
      if (viewport && following) viewport.scrollTop = viewport.scrollHeight;
    });
  }

  function followLatest() {
    setFollowing(true);
    scheduleFollow();
  }

  function dispose() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
  }

  return {
    dispose,
    followLatest,
    handleScroll,
    isFollowing: () => following,
    notifyContentResize: scheduleFollow,
  };
}
