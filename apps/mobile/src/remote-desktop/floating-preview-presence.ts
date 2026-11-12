import { useEffect, useRef, useState } from 'react';

export const FLOATING_PREVIEW_ENTER_DURATION_MS = 180;
export const FLOATING_PREVIEW_EXIT_DURATION_MS = 140;
export const FLOATING_PREVIEW_PRESENCE_SCALE = 0.96;
export const FLOATING_PREVIEW_PRESENCE_OFFSET = 8;

/** Keeps the floating preview mounted until its exit transition has finished. */
export function useFloatingPreviewPresence(visible: boolean, reduceMotion: boolean) {
  const [present, setPresent] = useState(visible);
  const [renderedVisible, setRenderedVisible] = useState(visible);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (visible !== renderedVisible) {
    setRenderedVisible(visible);
    if (visible && !present) setPresent(true);
  }

  useEffect(() => {
    if (visible || !present) return;
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      setPresent(false);
    }, reduceMotion ? 0 : FLOATING_PREVIEW_EXIT_DURATION_MS);
    return () => {
      if (exitTimerRef.current === null) return;
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    };
  }, [present, reduceMotion, visible]);

  return visible || present;
}
