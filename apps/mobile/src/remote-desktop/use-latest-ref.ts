import { useEffect, useRef } from 'react';

/** Keeps callback-only state out of the render path while still exposing the
 * latest committed value to long-lived native gesture handlers. */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; }, [value]);
  return ref;
}
