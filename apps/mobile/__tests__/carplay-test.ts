import { ControlPlaneAiSessionsSchema } from '@task-handoff/control-plane-client';

import { projectCarPlaySessions } from '../src/carplay/model';
import { translate } from '../src/i18n';

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en-US', key, params);

test('projects authoritative AI sessions into bounded CarPlay sections', () => {
  const snapshot = ControlPlaneAiSessionsSchema.parse({
    updatedAt: '2026-08-08T00:12:00.000Z',
    instances: [{
      instanceId: 'instance-1',
      streamId: 'stream-1',
      revision: 1,
      aiSessions: {
        updatedAt: '2026-08-08T00:10:00.000Z',
        runningCount: 2,
        waitingCount: 1,
        staleCount: 0,
        sessions: [
          {
            id: 'approval', agent: 'codex', status: 'waiting', phase: 'approval', title: 'Approve deployment',
            startedAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:10:00.000Z',
          },
          {
            id: 'running', agent: 'codex', status: 'running', phase: 'editing', title: 'Fix login', lastMessage: 'Editing the authentication flow',
            startedAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:09:00.000Z',
          },
          {
            id: 'idle', agent: 'codex', status: 'idle', phase: 'unknown', title: 'Finished task', summary: 'All checks passed',
            startedAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:08:00.000Z',
            turns: [{ id: 'recent-turn', userPrompt: 'Recent request', startedAt: '2026-08-08T00:07:00.000Z' }],
          },
          {
            id: 'idle-with-later-assistant-update', agent: 'codex', status: 'idle', phase: 'unknown', title: 'Older task', summary: 'Updated later by the assistant',
            startedAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:11:00.000Z',
            turns: [{ id: 'older-turn', userPrompt: 'Older request', startedAt: '2026-08-08T00:01:00.000Z', updatedAt: '2026-08-08T00:11:00.000Z' }],
          },
        ],
      },
    }],
  });

  const projection = projectCarPlaySessions(snapshot, new Map([['instance-1', 'Mac Studio']]), [], t);

  expect(projection.updatedAt).toBe(snapshot.updatedAt);
  expect(projection.featured?.id).toBe('running');
  expect(projection.sections.map((section) => [section.title, section.sessions.map((session) => session.id)])).toEqual([
    ['Needs attention', ['approval']],
    ['Active', ['running']],
    ['Recent', ['idle', 'idle-with-later-assistant-update']],
  ]);
  expect(projection.sections[0].sessions[0]).toEqual(expect.objectContaining({ instance: 'Mac Studio', status: 'Approval needed' }));
});
