import { useEffect, useRef } from 'react';
import { useRouter, type Href } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';

/** Keeps a compact detail route usable while making the same target available to a wide workbench. */
export function useWideDetailRoute({
  href,
  selectionKey,
  select,
  wide,
}: {
  href: Href;
  selectionKey: string;
  select(): void;
  wide: boolean;
}) {
  const router = useRouter();
  const focused = useIsFocused();
  const latest = useRef({ href, select });
  useEffect(() => { latest.current = { href, select }; }, [href, select]);
  useEffect(() => {
    latest.current.select();
  }, [selectionKey]);
  useEffect(() => {
    // A covered compact detail route must not collapse its own stack when the
    // device rotates. Otherwise opening a full-screen child (for example remote
    // desktop) in portrait and then rotating to landscape dismisses that child.
    if (focused && wide) router.dismissTo(latest.current.href);
  }, [focused, router, wide]);
}
