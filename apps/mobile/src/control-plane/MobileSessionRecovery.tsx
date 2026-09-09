import { useEffect } from 'react';
import { router, usePathname } from 'expo-router';

import { useMobileControlPlaneRuntime } from './use-mobile-control-plane-runtime';
import { mobileSessionRecoveryRoute } from './session-recovery';

export function MobileSessionRecovery() {
  const pathname = usePathname();
  const runtime = useMobileControlPlaneRuntime();

  useEffect(() => {
    const route = mobileSessionRecoveryRoute(runtime.phase, runtime.profile, pathname);
    if (route) router.replace(route);
  }, [pathname, runtime.phase, runtime.profile]);

  return null;
}
