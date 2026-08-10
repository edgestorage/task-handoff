import { useEffect, useState } from 'react';

import { hasActiveCloudAccount, restoreActiveCloudAccountSession, subscribeCloudAccountState } from './runtime';

type CloudAccountProfile = {
  id?: string;
  email?: string;
  emailVerified?: boolean;
};

export type CloudAccountState =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  | { phase: 'signed-in'; profile?: CloudAccountProfile };

export function useCloudAccountState() {
  const [state, setState] = useState<CloudAccountState>({ phase: 'loading' });

  useEffect(() => {
    let live = true;
    let request = 0;
    const load = async () => {
      const currentRequest = ++request;
      const active = await hasActiveCloudAccount().catch(() => false);
      if (!live || currentRequest !== request) return;
      if (!active) {
        setState({ phase: 'signed-out' });
        return;
      }

      // The secure device session is the login authority. Account details are
      // an online enrichment and never replace that local signed-in state.
      setState({ phase: 'signed-in' });
      try {
        const session = await restoreActiveCloudAccountSession();
        const profile = await session.client.profile() as CloudAccountProfile;
        if (live && currentRequest === request) setState({ phase: 'signed-in', profile });
      } catch {
        const stillActive = await hasActiveCloudAccount().catch(() => false);
        if (live && currentRequest === request && !stillActive) setState({ phase: 'signed-out' });
      }
    };

    const unsubscribe = subscribeCloudAccountState(() => { void load(); });
    void load();
    return () => { live = false; request += 1; unsubscribe(); };
  }, []);

  return state;
}
