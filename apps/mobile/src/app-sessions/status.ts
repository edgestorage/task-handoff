import type { AppSessionRecord } from '@task-handoff/protocol/app-sessions';

const CLOSED_APP_SESSION_STATUSES = new Set<AppSessionRecord['status']>([
  'stopped',
  'exited',
  'failed',
  'closed',
  'terminated',
]);

export function canCloseAppSession(status: AppSessionRecord['status']) {
  return !CLOSED_APP_SESSION_STATUSES.has(status);
}
