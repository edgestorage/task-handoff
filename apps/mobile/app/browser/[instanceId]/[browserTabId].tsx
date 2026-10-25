import { useLocalSearchParams } from 'expo-router';

import { BrowserTabScreen } from '../../../src/browser/BrowserTabScreen';
import { useMasterDetailLayout } from '../../../src/components/MasterDetailLayout';
import { useMobileControlPlaneRuntime } from '../../../src/control-plane/use-mobile-control-plane-runtime';
import { browserTabDetailSelection } from '../../../src/master-detail/selection';
import { useWideDetailRoute } from '../../../src/master-detail/use-wide-detail-route';

export default function BrowserTabRoute() {
  const params = useLocalSearchParams<{ instanceId: string; browserTabId: string }>();
  const instanceId = first(params.instanceId);
  const browserTabId = first(params.browserTabId);
  const runtime = useMobileControlPlaneRuntime();
  const { wide } = useMasterDetailLayout();
  useWideDetailRoute({
    href: '/(tabs)/(main)/apps',
    selectionKey: `${runtime.controlPlaneId || ''}:${instanceId}:${browserTabId}`,
    select: () => {
      if (runtime.controlPlaneId) browserTabDetailSelection.set({ browserTabId, controlPlaneId: runtime.controlPlaneId, instanceId });
    },
    wide,
  });
  return wide ? null : <BrowserTabScreen browserTabId={browserTabId} instanceId={instanceId} />;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}
