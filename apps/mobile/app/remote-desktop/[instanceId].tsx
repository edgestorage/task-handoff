import { useLocalSearchParams } from 'expo-router';

import { RemoteDesktopScreen } from '../../src/remote-desktop/RemoteDesktopScreen';

export default function RemoteDesktopRoute() {
  const params = useLocalSearchParams<{ instanceId: string; sessionId?: string }>();
  return <RemoteDesktopScreen instanceId={first(params.instanceId)} sessionId={first(params.sessionId) || undefined} />;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}
