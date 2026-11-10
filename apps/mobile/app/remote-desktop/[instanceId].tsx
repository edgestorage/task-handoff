import { useLocalSearchParams } from 'expo-router';

import { RemoteDesktopScreen } from '../../src/remote-desktop/RemoteDesktopScreen';

export default function RemoteDesktopRoute() {
  const params = useLocalSearchParams<{ instanceId: string }>();
  return <RemoteDesktopScreen instanceId={first(params.instanceId)} />;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}
