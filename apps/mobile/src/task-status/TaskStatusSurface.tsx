import * as Linking from 'expo-linking';
import { useEffect, useMemo } from 'react';

import { useActiveAiSessions } from '../ai-sessions/use-active-sessions';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import { projectSessionTaskStatus, projectTaskStatus } from './model';
import { syncTaskStatusSurfaces } from './runtime';
import { useTaskStatusSettings } from './settings';

export function TaskStatusSurface() {
  const { state } = useActiveAiSessions();
  const { state: directory } = useActiveDirectories();
  const { t } = useI18n();
  const { autoStart, available, loaded, stopTracking, trackedSession } = useTaskStatusSettings();
  const instanceNames = useMemo(
    () => new Map(directory.instances.map((instance) => [instance.id, instance.name])),
    [directory.instances],
  );
  const projection = useMemo(
    () => projectTaskStatus(state.snapshot, instanceNames, t),
    [instanceNames, state.snapshot, t],
  );
  const liveActivityProjection = useMemo(() => {
    if (autoStart) return projection;
    if (!trackedSession || trackedSession.controlPlaneId !== state.controlPlaneId) return undefined;
    const session = state.snapshot?.instances
      .find((entry) => entry.instanceId === trackedSession.instanceId)
      ?.aiSessions.sessions.find((candidate) => candidate.id === trackedSession.sessionId);
    return session
      ? projectSessionTaskStatus(
        session,
        instanceNames.get(trackedSession.instanceId) || trackedSession.instanceId,
        t,
      )
      : undefined;
  }, [autoStart, instanceNames, projection, state.controlPlaneId, state.snapshot, t, trackedSession]);
  const endLiveActivity = autoStart
    ? Boolean(state.snapshot && !liveActivityProjection?.shouldShowLiveActivity)
      : trackedSession
      ? Boolean((trackedSession.controlPlaneId !== state.controlPlaneId || state.snapshot) && !liveActivityProjection?.shouldShowLiveActivity)
      : true;
  const activityUrl = !autoStart && trackedSession
    ? Linking.createURL(`/sessions/${encodeURIComponent(trackedSession.instanceId)}/${encodeURIComponent(trackedSession.sessionId)}`)
    : Linking.createURL('/');

  useEffect(() => {
    if (!available || !loaded) return;
    let live = true;
    void syncTaskStatusSurfaces({
      widget: projection.props,
      ...(liveActivityProjection?.shouldShowLiveActivity ? { liveActivity: liveActivityProjection.props } : {}),
      ...(endLiveActivity ? { endLiveActivity: true } : {}),
    }, activityUrl).then(() => {
      if (live && trackedSession && !autoStart && endLiveActivity) {
        void stopTracking();
      }
      return undefined;
    }).catch((error) => {
      if (__DEV__) console.warn('Could not update task status widgets', error);
    });
    return () => { live = false; };
  }, [activityUrl, autoStart, available, endLiveActivity, liveActivityProjection, loaded, projection.props, stopTracking, trackedSession]);

  return null;
}
