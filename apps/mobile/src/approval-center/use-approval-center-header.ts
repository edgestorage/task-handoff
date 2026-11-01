import { useContext, useEffect } from 'react';
import { Platform } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { approvalCenterHeaderFallback } from './geometry';
import { useMobileApprovalCenter } from './use-mobile-approval-center';

export function useApprovalCenterHeaderInset() {
  const insets = useContext(SafeAreaInsetsContext);
  const { registerHeaderInset } = useMobileApprovalCenter();
  useEffect(
    () => registerHeaderInset(approvalCenterHeaderFallback(Platform.OS, insets?.top ?? 0)),
    [insets?.top, registerHeaderInset],
  );
}
