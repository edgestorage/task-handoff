import { ControlPlaneAiSessionsSchema, normalizeManualStoryOrder, reorderStoryKeys, type ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';
import type { Story } from '@task-handoff/protocol/stories';

import { groupStoryTreeSessions, mergeStoryTreeSnapshot, replaceVisibleStoryOrder, sortStoryTree, storyDragPreview, storyDragRowHeight, storyDragShifts, STORY_TREE_ROW_GAP, unassignedStoryRootInstanceIds, visibleStoryTreeDocuments } from '../src/stories/story-tree-model';

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
    const preview = storyDragPreview(keys, 'n1:b', 25, [
      { key: 'n1:b', center: 25, height: 50 },
      { key: 'n1:a', center: 90, height: 60 },
      { key: 'n2:c', center: 150, height: 40 },
    ], 75, STORY_TREE_ROW_GAP);
    expect(preview.keys).toEqual(['n1:a', 'n1:b', 'n2:c']);
    expect(preview.offsetY).toBe(7);
  });

  test('keeps the dragged Story under the pointer when row heights differ', () => {
    const keys = ['n1:a', 'n1:b', 'n1:c'];
    const targets = [
      { key: 'n1:a', center: 50, height: 100 },
      { key: 'n1:b', center: 208, height: 200 },
      { key: 'n1:c', center: 346, height: 60 },
    ];
    const beforeSwap = storyDragPreview(keys, 'n1:a', 50, targets, 70, STORY_TREE_ROW_GAP);
    expect(beforeSwap.keys).toEqual(keys);
    expect(beforeSwap.offsetY).toBe(70);

    const firstSwap = storyDragPreview(keys, 'n1:a', 50, targets, 100, STORY_TREE_ROW_GAP);
    expect(firstSwap.keys).toEqual(['n1:b', 'n1:a', 'n1:c']);
    expect(firstSwap.offsetY).toBe(-108);

    const secondSwap = storyDragPreview(keys, 'n1:a', 50, targets, 250, STORY_TREE_ROW_GAP);
    expect(secondSwap.keys).toEqual(['n1:b', 'n1:c', 'n1:a']);
    expect(secondSwap.offsetY).toBe(-26);
  });

  test('starts a Story drop at the released position relative to its target slot', () => {
    const keys = ['n1:a', 'n1:b', 'n1:c'];
    const targets = [
      { key: 'n1:a', center: 50, height: 100 },
      { key: 'n1:b', center: 208, height: 200 },
      { key: 'n1:c', center: 346, height: 60 },
    ];
    const drop = storyDragPreview(keys, 'n1:a', 50, targets, 120, STORY_TREE_ROW_GAP);
    expect(drop.keys).toEqual(['n1:b', 'n1:a', 'n1:c']);
    expect(drop.offsetY).toBe(-88);
  });

  test('moves surrounding Story rows by their preview positions without reordering the list', () => {
    const source = ['n1:a', 'n1:b', 'n1:c'];
    const targets = [
      { key: 'n1:a', height: 100 },
      { key: 'n1:b', height: 200 },
      { key: 'n1:c', height: 60 },
    ];

    expect(Object.fromEntries(storyDragShifts(source, ['n1:b', 'n1:a', 'n1:c'], targets, STORY_TREE_ROW_GAP))).toEqual({
      'n1:a': 208,
      'n1:b': -108,
      'n1:c': 0,
    });
    expect(Object.fromEntries(storyDragShifts(source, ['n1:b', 'n1:c', 'n1:a'], targets, STORY_TREE_ROW_GAP))).toEqual({
      'n1:a': 276,
      'n1:b': -108,
      'n1:c': -108,
    });
  });

  test('uses the collapsed header height instead of a stale expanded group measurement', () => {
    expect(storyDragRowHeight(false, 320, 50, 1)).toBe(52);
    expect(storyDragRowHeight(true, 320, 50, 1)).toBe(320);
    expect(storyDragRowHeight(false, 320, undefined, 1)).toBe(320);
  });

  test('merges a visible reorder back into the complete manual order', () => {
    expect(replaceVisibleStoryOrder(
      ['n1:a', 'n1:hidden', 'n1:b', 'n1:c'],
      ['n1:c', 'n1:a', 'n1:b'],
    )).toEqual(['n1:c', 'n1:hidden', 'n1:a', 'n1:b']);
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
