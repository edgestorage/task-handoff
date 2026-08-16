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
  let manuallyPaused = false;
  let movedAwayAfterManualPause = false;
  let observedScrollHeight: number | undefined;
  const smoothApproachDistance = 1600;

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

  function cancelAutomaticScroll() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    const viewport = getViewport();
    if (autoScrolling && viewport?.scrollTo) {
      viewport.scrollTo({ top: viewport.scrollTop, behavior: "auto" });
    }
    setAutoScrolling(false);
  }

  function handleScroll() {
    const viewport = getViewport();
    if (!viewport) return;
    const contentGrew = observedScrollHeight !== undefined
      && viewport.scrollHeight > observedScrollHeight + 0.25;
    observedScrollHeight = viewport.scrollHeight;
    if (manuallyPaused) {
      const distance = distanceFromBottom(viewport);
      if (distance > 0.5) movedAwayAfterManualPause = true;
      if (movedAwayAfterManualPause && distance <= 0.5) {
        manuallyPaused = false;
        movedAwayAfterManualPause = false;
        setFollowing(true);
      } else {
        setFollowing(false);
      }
      return;
    }
    if (following && !autoScrolling && contentGrew) {
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      return;
    }
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
      observedScrollHeight = viewport.scrollHeight;
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
    observedScrollHeight = viewport.scrollHeight;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }

  function followLatest() {
    manuallyPaused = false;
    movedAwayAfterManualPause = false;
    setFollowing(true);
    setAutoScrolling(true);
    scheduleFollow();
  }

  function jumpLatest() {
    cancelAutomaticScroll();
    manuallyPaused = false;
    movedAwayAfterManualPause = false;
    setFollowing(true);
    const viewport = getViewport();
    if (!viewport) return;
    observedScrollHeight = viewport.scrollHeight;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  }

  function pauseFollowing() {
    cancelAutomaticScroll();
    const viewport = getViewport();
    if (viewport) observedScrollHeight = viewport.scrollHeight;
    setFollowing(Boolean(viewport && distanceFromBottom(viewport) <= threshold));
  }

  function stopFollowing() {
    cancelAutomaticScroll();
    manuallyPaused = true;
    movedAwayAfterManualPause = false;
    setFollowing(false);
  }

  function dispose() {
    cancelAutomaticScroll();
  }

  return {
    dispose,
    followLatest,
    handleScroll,
    isAutoScrolling: () => autoScrolling,
    isFollowing: () => following,
    jumpLatest,
    notifyContentResize: maintainLatest,
    pauseFollowing,
    stopFollowing,
  };
}
