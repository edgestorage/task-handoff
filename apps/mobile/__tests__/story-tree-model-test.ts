import { ControlPlaneAiSessionsSchema, normalizeManualStoryOrder, reorderStoryKeys, type ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';
import type { Story } from '@task-handoff/protocol/stories';

import { groupStoryTreeSessions, mergeStoryTreeSnapshot, sortStoryTree, storyDragPreview, unassignedStoryRootInstanceIds, visibleStoryTreeDocuments } from '../src/stories/story-tree-model';

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

  test('supports recent-session and manual sort modes', () => {
    const stories = [story('older', 'n1', 'Older'), story('newer', 'n1', 'Newer')];
    const sessions = new Map([
      ['n1:older', [{ instanceId: 'i', instanceName: 'I', session: { updatedAt: '2026-09-04T01:00:00.000Z', lastUserMessageAt: '2026-09-04T01:00:00.000Z' } } as never]],
      ['n1:newer', [{ instanceId: 'i', instanceName: 'I', session: { updatedAt: '2026-09-04T02:00:00.000Z', lastUserMessageAt: '2026-09-04T02:00:00.000Z' } } as never]],
    ]);
    expect(sortStoryTree(stories, 'en-US', 'last-user-message', sessions).map((item) => item.id)).toEqual(['newer', 'older']);
    expect(sortStoryTree(stories, 'en-US', 'manual', sessions, ['n1:older', 'n1:newer']).map((item) => item.id)).toEqual(['older', 'newer']);
  });

  test('normalizes, reorders, and previews the complete manual Story order', () => {
    const stories = [story('a', 'n1', 'A'), story('b', 'n1', 'B'), story('c', 'n2', 'C')];
    const keys = normalizeManualStoryOrder(stories, ['n1:b', 'missing', 'n1:b']);
    expect(keys).toEqual(['n1:a', 'n2:c', 'n1:b']);
    expect(reorderStoryKeys(keys, 'n1:a', 'n1:b', 'after')).toEqual(['n2:c', 'n1:b', 'n1:a']);
    expect(storyDragPreview(keys, 'n1:b', 25, [
      { key: 'n1:b', center: 25 },
      { key: 'n1:a', center: 85 },
      { key: 'n2:c', center: 145 },
    ], 75).keys).toEqual(['n1:a', 'n1:b', 'n2:c']);
  });

  test('keeps archived Stories after active Stories in every sort mode', () => {
    const active = story('active', 'n1', 'Z');
    const archived = { ...story('archived', 'n1', 'A'), archivedAt: '2026-09-06T00:00:00.000Z' };
    const stories = [archived, active];
    const sessions = new Map([
      ['n1:archived', [{ instanceId: 'i', instanceName: 'I', session: { lastUserMessageAt: '2026-09-04T02:00:00.000Z' } } as never]],
      ['n1:active', [{ instanceId: 'i', instanceName: 'I', session: { lastUserMessageAt: '2026-09-04T01:00:00.000Z' } } as never]],
    ]);

    for (const mode of ['name', 'last-user-message', 'manual'] as const) {
      expect(sortStoryTree(stories, 'en-US', mode, sessions, ['n1:archived', 'n1:active']).map((item) => item.id)).toEqual(['active', 'archived']);
    }
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

  test('links descendants from the Story root and counts one expandable tree', () => {
    const stories = [story('story-1', 'node-a', 'A')];
    const instances = [{ id: 'instance-a', nodeId: 'node-a', name: 'Instance A' }] as ControlPlaneInstanceResourceEntry[];
    const base = { agent: 'codex', status: 'idle' as const, startedAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z', unread: false };
    const snapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: base.updatedAt,
      instances: [{ instanceId: 'instance-a', streamId: 'a', aiSessions: { updatedAt: base.updatedAt, sessions: [
        { ...base, id: 'root', providerSessionId: 'provider-root', storyId: 'story-1' },
        { ...base, id: 'child', providerSessionId: 'provider-child', lineage: { kind: 'subagent', parentProviderSessionId: 'provider-root' } },
        { ...base, id: 'grandchild', providerSessionId: 'provider-grandchild', lineage: { kind: 'subagent', parentProviderSessionId: 'provider-child' } },
      ] } }],
    });

    expect(groupStoryTreeSessions(stories, instances, snapshot).get('node-a:story-1')?.map((entry) => [entry.session.id, entry.depth, entry.hasChildren])).toEqual([
      ['root', 0, true],
    ]);
    expect(groupStoryTreeSessions(stories, instances, snapshot, new Set(['root', 'child'])).get('node-a:story-1')?.map((entry) => [entry.session.id, entry.depth])).toEqual([
      ['root', 0], ['child', 1], ['grandchild', 2],
    ]);
    expect(unassignedStoryRootInstanceIds(snapshot)).toEqual(new Set());
  });

  test('shows only the latest five documents until expanded', () => {
    const documents = Array.from({ length: 7 }, (_, index) => ({ title: `Doc ${index + 1}`, storyPath: `doc-${index + 1}.md`, revision: 'r1' }));
    expect(visibleStoryTreeDocuments(documents, false).map((item) => item.storyPath)).toEqual(['doc-3.md', 'doc-4.md', 'doc-5.md', 'doc-6.md', 'doc-7.md']);
    expect(visibleStoryTreeDocuments(documents, true)).toHaveLength(7);
  });

  test('retains the last authoritative Stories for unavailable nodes', () => {
    const current = [story('keep', 'node-offline', 'Keep'), story('replace', 'node-online', 'Old')];
    const incoming = [story('replace', 'node-online', 'Updated')];

    expect(mergeStoryTreeSnapshot(current, incoming, ['node-offline']).map((item) => item.title)).toEqual(['Updated', 'Keep']);
    expect(mergeStoryTreeSnapshot(current, [], []).map((item) => item.title)).toEqual([]);
  });
});
