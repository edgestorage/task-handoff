import type { LiveActivity } from 'expo-widgets';

import TaskStatusActivity from '../../widgets/TaskStatusActivity';
import TaskStatusWidget from '../../widgets/TaskStatusWidget';
import type { TaskStatusProps, TaskStatusSurfacesState } from './model';

let activity: LiveActivity<TaskStatusProps> | undefined;
let activityUrl: string | undefined;
let lastSnapshot = '';
let queue = Promise.resolve();

export function syncTaskStatusSurfaces(state: TaskStatusSurfacesState, url: string) {
  queue = queue.catch(() => undefined).then(() => sync(state, url));
  return queue;
}

async function sync(state: TaskStatusSurfacesState, url: string) {
  const serialized = JSON.stringify({ state, url });
  if (serialized === lastSnapshot) return;
  TaskStatusWidget.updateSnapshot(state.widget);

  if (!state.liveActivity && !state.endLiveActivity) {
    lastSnapshot = serialized;
    return;
  }
  let existing = activity ? [activity] : TaskStatusActivity.getInstances();
  if (!state.liveActivity) {
    await Promise.all(existing.map((instance) => instance.end('default', state.widget, new Date())));
    activity = undefined;
    activityUrl = undefined;
    lastSnapshot = serialized;
    return;
  }

  if ((!activity && existing.length > 0) || (activity && activityUrl !== url)) {
    await Promise.all(existing.map((instance) => instance.end('immediate')));
    activity = undefined;
    existing = [];
  }
  activity = existing[0] ?? TaskStatusActivity.start(state.liveActivity, url);
  activityUrl = url;
  await Promise.all([
    activity.update(state.liveActivity),
    ...existing.slice(1).map((instance) => instance.end('immediate')),
  ]);
  lastSnapshot = serialized;
}
