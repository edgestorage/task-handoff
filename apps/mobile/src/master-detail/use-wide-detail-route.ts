import { useEffect, useRef } from 'react';
import { useRouter, type Href } from 'expo-router';

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
  const latest = useRef({ href, select });
  useEffect(() => { latest.current = { href, select }; }, [href, select]);
  useEffect(() => {
    latest.current.select();
  }, [selectionKey]);
  useEffect(() => {
    if (wide) router.dismissTo(latest.current.href);
  }, [router, wide]);
}
