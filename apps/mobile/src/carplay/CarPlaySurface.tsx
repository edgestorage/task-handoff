import { useEffect, useMemo } from 'react';

import { useActiveAiSessions } from '../ai-sessions/use-active-sessions';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import { projectCarPlaySessions } from './model';
import { updateCarPlay } from './runtime';

export function CarPlaySurface() {
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

  useEffect(() => {
    updateCarPlay(projection);
  }, [projection]);

  return null;
}
