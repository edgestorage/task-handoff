import { createContext, useContext, useEffect, useId } from 'react';

/** Layout demand only: no session/resource state crosses this boundary. */
export const DetailSpaceContext = createContext<{
  availableWidth: number;
  request(id: string, minimumWidth?: number): void;
} | undefined>(undefined);

export function useDetailSpace(minimumWidth?: number) {
  const context = useContext(DetailSpaceContext);
  const id = useId();
  const request = context?.request;
  useEffect(() => {
    request?.(id, minimumWidth);
    return () => request?.(id);
  }, [id, minimumWidth, request]);
}
