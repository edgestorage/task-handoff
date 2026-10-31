import { StyleSheet, View } from 'react-native';

import { useApprovalCenterOcclusion } from '../approval-center/use-mobile-approval-center';
import { InitialSyncLoading, isDeviceTrustPhase } from '../components/InitialSyncLoading';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from './use-mobile-control-plane-runtime';

export function MobileDeviceTrustGate({ onOpenSettings }: { onOpenSettings?: () => void } = {}) {
  const runtime = useMobileControlPlaneRuntime();
  const { colors } = useMobileTheme();
  const active = Boolean(runtime.deviceTrust && isDeviceTrustPhase(runtime.phase));
  useApprovalCenterOcclusion('modal', active);
  if (!active) return null;
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
