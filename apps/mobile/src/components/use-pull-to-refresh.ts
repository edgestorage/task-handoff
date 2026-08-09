import { useCallback, useRef, useState } from 'react';

export function usePullToRefresh(refresh?: () => Promise<void>) {
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  const onRefresh = useCallback(() => {
    if (!refresh || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    void refresh()
      .catch(() => undefined)
      .finally(() => {
        refreshInFlight.current = false;
        setRefreshing(false);
      });
  }, [refresh]);

  return { onRefresh: refresh ? onRefresh : undefined, refreshing };
}
