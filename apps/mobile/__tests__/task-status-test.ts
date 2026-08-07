import { ControlPlaneAiSessionsSchema } from '@task-handoff/control-plane-client';

import { translate } from '../src/i18n';
import { projectSessionTaskStatus, projectTaskStatus } from '../src/task-status/model';
import { parseTaskStatusSettings } from '../src/task-status/settings';

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en-US', key, params);

describe('task status projection', () => {
  test('prioritizes an approval and derives all counts from the authoritative snapshot', () => {
    const snapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-08-08T00:10:00.000Z',
      instances: [{
        instanceId: 'instance-1',
        streamId: 'stream-1',
        revision: 1,
        aiSessions: {
          runningCount: 1,
          waitingCount: 1,
          staleCount: 0,
          updatedAt: '2026-08-08T00:10:00.000Z',
          sessions: [
            { id: 'running', agent: 'codex', status: 'running', phase: 'responding', title: 'Build mobile', startedAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:10:00.000Z' },
            { id: 'approval', agent: 'codex', status: 'waiting', phase: 'approval', title: 'Review permissions', startedAt: '2026-08-08T00:01:00.000Z', updatedAt: '2026-08-08T00:09:00.000Z' },
            { id: 'failed', agent: 'codex', status: 'failed', phase: 'unknown', title: 'Old failure', startedAt: '2026-08-08T00:02:00.000Z', updatedAt: '2026-08-08T00:08:00.000Z' },
          ],
        },
      }],
    });

    expect(projectTaskStatus(snapshot, new Map([['instance-1', 'Mac Studio']]), t)).toEqual({
      props: {
        activeCount: 1,
        detail: 'Mac Studio',
        message: 'No response yet.',
        problemCount: 1,
        status: 'waiting',
        statusLabel: 'Approval needed',
        title: 'Review permissions',
        waitingCount: 1,
      },
      shouldShowLiveActivity: true,
    });
  });

  test('ends the Live Activity while retaining the latest settled task in the widget', () => {
    const snapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-08-08T00:10:00.000Z',
      instances: [{
        instanceId: 'instance-1',
        streamId: 'stream-1',
        revision: 1,
        aiSessions: {
          runningCount: 0,
          waitingCount: 0,
          staleCount: 0,
          updatedAt: '2026-08-08T00:10:00.000Z',
          sessions: [{ id: 'done', agent: 'codex', status: 'idle', phase: 'unknown', title: 'Build completed', lastMessage: 'The build is ready.', startedAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:10:00.000Z' }],
        },
      }],
    });

    const result = projectTaskStatus(snapshot, new Map(), t);
    expect(result.shouldShowLiveActivity).toBe(false);
    expect(result.props).toEqual(expect.objectContaining({ message: 'The build is ready.', status: 'idle', title: 'Build completed' }));
  });

  test('produces an idle empty snapshot before a Control Plane is connected', () => {
    expect(projectTaskStatus(undefined, new Map(), t)).toEqual(expect.objectContaining({
      props: expect.objectContaining({ activeCount: 0, problemCount: 0, status: 'idle', waitingCount: 0 }),
      shouldShowLiveActivity: false,
    }));
  });

  test('projects a manually tracked Live Activity from only the selected session', () => {
    const snapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-08-08T00:10:00.000Z',
      instances: [{
        instanceId: 'instance-1', streamId: 'stream-1', revision: 1,
        aiSessions: {
          runningCount: 1, waitingCount: 0, staleCount: 0, updatedAt: '2026-08-08T00:10:00.000Z',
          sessions: [{ id: 'tracked', agent: 'codex', status: 'running', phase: 'editing', title: 'Selected task', startedAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:10:00.000Z' }],
        },
      }],
    });
    expect(projectSessionTaskStatus(snapshot.instances[0].aiSessions.sessions[0], 'Mac Studio', t)).toEqual({
      props: {
        activeCount: 1,
        detail: 'Mac Studio',
        message: 'No response yet.',
        problemCount: 0,
        status: 'active',
        statusLabel: 'Active',
        title: 'Selected task',
        waitingCount: 0,
      },
      shouldShowLiveActivity: true,
    });
  });

  test('shows the latest complete AI message from the authoritative snapshot', () => {
    const snapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-08-08T00:10:00.000Z',
      instances: [{
        instanceId: 'instance-1', streamId: 'stream-1', revision: 1,
        aiSessions: {
          runningCount: 1, waitingCount: 0, staleCount: 0, updatedAt: '2026-08-08T00:10:00.000Z',
          sessions: [{
            id: 'tracked', agent: 'codex', status: 'running', phase: 'responding', title: 'Selected task',
            activeTurnId: 'turn-1', startedAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:10:00.000Z',
            lastMessage: 'Older complete response',
            turns: [{ id: 'turn-1', status: 'running', revision: 1, lastMessage: 'Newest complete AI response' }],
          }],
        },
      }],
    });
    expect(projectTaskStatus(snapshot, new Map(), t).props.message).toBe('Newest complete AI response');
    expect(projectSessionTaskStatus(snapshot.instances[0].aiSessions.sessions[0], 'Mac Studio', t).props.message)
      .toBe('Newest complete AI response');
  });

  test('sanitizes persisted auto and manual settings', () => {
    expect(parseTaskStatusSettings(undefined)).toEqual({ version: 1, autoStart: false });
    expect(parseTaskStatusSettings(JSON.stringify({
      version: 1,
      autoStart: false,
      trackedSession: { controlPlaneId: 'cp-1', instanceId: 'i-1', sessionId: 's-1', unknown: true },
      unknown: true,
    }))).toEqual({
      version: 1,
      autoStart: false,
      trackedSession: { controlPlaneId: 'cp-1', instanceId: 'i-1', sessionId: 's-1' },
    });
    expect(parseTaskStatusSettings(JSON.stringify({
      version: 1,
      autoStart: true,
      trackedSession: { controlPlaneId: 'cp-1', instanceId: 'i-1', sessionId: 's-1' },
    }))).toEqual({ version: 1, autoStart: true });
  });
});
