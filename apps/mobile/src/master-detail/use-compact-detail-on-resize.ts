import { useCallback, useEffect, useRef } from 'react';
import { router, useFocusEffect, type Href } from 'expo-router';

/** Preserve the visible detail when a wide workbench becomes too narrow for two panes. */
export function useCompactDetailOnResize({
  enabled,
  href,
  wide,
}: {
  enabled: boolean;
  href?: Href;
  wide: boolean;
}) {
  const focused = useRef(false);
  const hrefRef = useRef<Href | undefined>(href);
  useEffect(() => { hrefRef.current = href; }, [href]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => { focused.current = false; };
  }, []));
  const previousWide = useRef(wide);
  useEffect(() => {
    const wasWide = previousWide.current;
    previousWide.current = wide;
    if (wasWide && !wide && enabled && focused.current && hrefRef.current) router.push(hrefRef.current);
  }, [enabled, wide]);
}
