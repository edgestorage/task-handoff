import { ControlPlaneAiSessionsSchema, type ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';
import type { Story } from '@task-handoff/protocol/stories';

import { groupStoryTreeSessions, sortStoryTree, visibleStoryTreeDocuments } from '../src/stories/story-tree-model';

const story = (id: string, ownerNodeId: string, title: string): Story => ({
  id,
  ownerNodeId,
  title,
  documents: [],
  actions: [],
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
});

describe('mobile Story tree model', () => {
  test('sorts Story roots by localized numeric title', () => {
    expect(sortStoryTree([story('3', 'n1', 'Story 10'), story('2', 'n1', 'story 2')], 'en-US').map((item) => item.id)).toEqual(['2', '3']);
  });

  test('links sessions through both the owning node and Story id', () => {
    const stories = [story('shared', 'node-a', 'A'), story('shared', 'node-b', 'B')];
    const instances = [
      { id: 'instance-a', nodeId: 'node-a', name: 'Instance A' },
      { id: 'instance-b', nodeId: 'node-b', name: 'Instance B' },
    ] as ControlPlaneInstanceResourceEntry[];
    const session = (id: string) => ({ id, agent: 'codex', storyId: 'shared', status: 'idle', startedAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z', unread: false });
    const snapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-09-04T00:00:00.000Z',
      instances: [
        { instanceId: 'instance-a', streamId: 'a', aiSessions: { updatedAt: '2026-09-04T00:00:00.000Z', sessions: [session('session-a')] } },
        { instanceId: 'instance-b', streamId: 'b', aiSessions: { updatedAt: '2026-09-04T00:00:00.000Z', sessions: [session('session-b')] } },
      ],
    });

    expect(groupStoryTreeSessions(stories, instances, snapshot).get('node-a:shared')?.map((entry) => entry.session.id)).toEqual(['session-a']);
    expect(groupStoryTreeSessions(stories, instances, snapshot).get('node-b:shared')?.map((entry) => entry.session.id)).toEqual(['session-b']);
  });

  test('shows only the latest five documents until expanded', () => {
    const documents = Array.from({ length: 7 }, (_, index) => ({ title: `Doc ${index + 1}`, storyPath: `doc-${index + 1}.md`, revision: 'r1' }));
    expect(visibleStoryTreeDocuments(documents, false).map((item) => item.storyPath)).toEqual(['doc-3.md', 'doc-4.md', 'doc-5.md', 'doc-6.md', 'doc-7.md']);
    expect(visibleStoryTreeDocuments(documents, true)).toHaveLength(7);
  });
});
