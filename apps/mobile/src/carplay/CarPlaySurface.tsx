import { useEffect, useMemo, useRef } from 'react';

import { useActiveAiSessions } from '../ai-sessions/use-active-sessions';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import { projectCarPlaySessions } from './model';
import { updateCarPlay } from './runtime';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';

const CARPLAY_STREAM_UPDATE_MS = 300;

export function CarPlaySurface() {
  const { carPlayConnected } = useMobileControlPlaneRuntime();
  return carPlayConnected ? <ConnectedCarPlaySurface /> : null;
}

function ConnectedCarPlaySurface() {
  const { state } = useActiveAiSessions();
  const { state: directory } = useActiveDirectories();
  const { t } = useI18n();
  const instanceNames = useMemo(
    () => new Map(directory.instances.map((instance) => [instance.id, instance.name])),
    [directory.instances],
  );
  const projection = useMemo(
    () => projectCarPlaySessions(state.snapshot, instanceNames, Object.values(state.messages), t),
    [instanceNames, state.messages, state.snapshot, t],
  );
  const lastProjection = useRef('');
  const pendingProjection = useRef(projection);
  const updateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const serialized = JSON.stringify(projection);
    if (serialized === lastProjection.current) return;
    pendingProjection.current = projection;
    if (updateTimer.current) return;
    updateTimer.current = setTimeout(() => {
      updateTimer.current = undefined;
      const pending = pendingProjection.current;
      const nextSerialized = JSON.stringify(pending);
      if (nextSerialized === lastProjection.current) return;
      lastProjection.current = nextSerialized;
      updateCarPlay(pending);
    }, CARPLAY_STREAM_UPDATE_MS);
  }, [projection]);

  useEffect(() => () => {
    if (updateTimer.current) clearTimeout(updateTimer.current);
  }, []);

  return null;
}
