import { StyleSheet, View } from 'react-native';

import { InitialSyncLoading, isDeviceTrustPhase } from '../components/InitialSyncLoading';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from './use-mobile-control-plane-runtime';

export function MobileDeviceTrustGate({ onOpenSettings }: { onOpenSettings?: () => void } = {}) {
  const runtime = useMobileControlPlaneRuntime();
  const { colors } = useMobileTheme();
  if (!runtime.deviceTrust || !isDeviceTrustPhase(runtime.phase)) return null;
  return <View
    style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, zIndex: 1_000 }]}
    testID="device-trust-gate"
  >
    <InitialSyncLoading
      onOpenSettings={onOpenSettings}
      resource="aiSessions"
      testID="device-trust-gate-content"
    />
  </View>;
}
