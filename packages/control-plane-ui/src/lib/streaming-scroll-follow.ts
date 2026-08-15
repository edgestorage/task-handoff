export interface ScrollViewport {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  scrollTo?: (options: ScrollToOptions) => void;
}

export interface StreamingScrollFollowOptions {
  cancelFrame?: (handle: number) => void;
  onAutoScrollingChange?: (autoScrolling: boolean) => void;
  onFollowingChange?: (following: boolean) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  threshold?: number;
}

export const STREAMING_SCROLL_FOLLOW_THRESHOLD = 48;

export function distanceFromBottom(viewport: ScrollViewport) {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
}

export function createStreamingScrollFollow(
  getViewport: () => ScrollViewport | undefined,
  options: StreamingScrollFollowOptions = {},
) {
  const threshold = options.threshold ?? STREAMING_SCROLL_FOLLOW_THRESHOLD;
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  let following = true;
  let autoScrolling = false;
  let frame: number | undefined;
  const smoothApproachDistance = 800;

  function setFollowing(value: boolean) {
    if (following === value) return;
    following = value;
    options.onFollowingChange?.(value);
  }

  function setAutoScrolling(value: boolean) {
    if (autoScrolling === value) return;
    autoScrolling = value;
    options.onAutoScrollingChange?.(value);
  }

  function handleScroll() {
    const viewport = getViewport();
    if (!viewport) return;
    if (autoScrolling) {
      if (distanceFromBottom(viewport) <= threshold) setAutoScrolling(false);
      return;
    }
    setFollowing(distanceFromBottom(viewport) <= threshold);
  }

  function scheduleFollow() {
    if (!following || frame !== undefined) return;
    frame = requestFrame(() => {
      frame = undefined;
      const viewport = getViewport();
      if (!viewport || !following) return;
      if (viewport.scrollTo) {
        const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        if (maxScrollTop - viewport.scrollTop > smoothApproachDistance) {
          viewport.scrollTop = Math.max(0, maxScrollTop - smoothApproachDistance);
        }
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
        if (distanceFromBottom(viewport) <= threshold) setAutoScrolling(false);
      } else {
        viewport.scrollTop = viewport.scrollHeight;
        setAutoScrolling(false);
      }
    });
  }

  function maintainLatest() {
    if (!following) return;
    if (autoScrolling) {
      scheduleFollow();
      return;
    }
    const viewport = getViewport();
    if (!viewport) return;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }

  function followLatest() {
    setFollowing(true);
    setAutoScrolling(true);
    scheduleFollow();
  }

  function pauseFollowing() {
    setAutoScrolling(false);
    const viewport = getViewport();
    setFollowing(Boolean(viewport && distanceFromBottom(viewport) <= threshold));
  }

  function stopFollowing() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    setAutoScrolling(false);
    setFollowing(false);
  }

  function dispose() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    setAutoScrolling(false);
  }

  return {
    dispose,
    followLatest,
    handleScroll,
    isAutoScrolling: () => autoScrolling,
    isFollowing: () => following,
    notifyContentResize: maintainLatest,
    pauseFollowing,
    stopFollowing,
  };
}
