import type { RepositoryDiff } from '@task-handoff/protocol/repository';

import { contextLineLimit, createSplitRows, diffPresentationRows, expandGap } from '../src/repository/repositoryDiffPresentation';
import { buildReviewTree, flattenReviewTree } from '../src/repository/repositoryChangePresentation';

const hunk = { kind: 'hunk' as const, content: '@@ -1 +1 @@', hunkId: 'hunk:1', newCount: 1, newStart: 1, oldCount: 1, oldStart: 1 };
const contextLine = { kind: 'context' as const, content: 'same', newLine: 1, oldLine: 1 };

function diff(overrides: Partial<RepositoryDiff>): RepositoryDiff {
  return {
    binary: false, byteLimit: 16_384, complete: true, content: '', contextGaps: [], lines: [], path: 'src/file.ts',
    scope: 'unstaged', snapshotId: 'snapshot_1', truncated: false, version: 'version_000000001', ...overrides,
  };
}

test('a hunk remains visible when the protocol omits context gaps', () => {
  expect(diffPresentationRows(diff({ lines: [hunk, contextLine] }), new Map())).toEqual([hunk, contextLine]);
});

test('context gaps expand near the current hunk with bounded context requests', () => {
  const contextGap = {
    afterHunkId: hunk.hunkId, gapId: 'gap:start:hunk:1', hasMore: true, lines: [], startLineCount: 0,
  };
  const expanded = expandGap(new Map(), contextGap.gapId, 'up', 20);
  const rows = diffPresentationRows(diff({ contextGaps: [contextGap], lines: [hunk, contextLine] }), expanded);

  expect(rows[0]).toMatchObject({ controls: [{ direction: 'up', gapId: contextGap.gapId, lineCount: 20 }], hunk, kind: 'context-control' });
  expect(rows).toContainEqual(contextLine);
  expect(contextLineLimit(expanded)).toBe(40);
});

test('split rows align paired changes and keep full-width hunk headers', () => {
  const deletion = { kind: 'deletion' as const, content: 'const value = 1', oldLine: 2 };
  const addition = { kind: 'addition' as const, content: 'const value = 2', newLine: 2 };
  const rows = createSplitRows([hunk, contextLine, deletion, addition]);

  expect(rows).toEqual([
    { kind: 'full', line: hunk },
    { kind: 'pair', oldLine: contextLine, newLine: contextLine },
    { kind: 'pair', oldLine: deletion, newLine: addition },
  ]);
});

test('changed file trees sort directories first, count unique files and collapse by directory', () => {
  const entries = [
    { path: 'src/live.ts', scope: 'unstaged' as const, status: 'modified' as const, version: 'version_000000001', binary: false },
    { path: 'README.md', scope: 'unstaged' as const, status: 'modified' as const, version: 'version_000000002', binary: false },
    { path: 'src/live.ts', scope: 'staged' as const, status: 'modified' as const, version: 'version_000000003', binary: false },
    { path: 'src/nested/added.ts', scope: 'staged' as const, status: 'added' as const, version: 'version_000000004', binary: false },
  ];
  const tree = buildReviewTree(entries);

  expect(tree.map((node) => node.key)).toEqual(['directory:src', 'file:README.md']);
  expect(tree[0]).toMatchObject({ fileCount: 2, kind: 'directory', name: 'src' });
  expect(flattenReviewTree(tree).map((node) => node.path)).toEqual(['src', 'src/nested', 'src/nested/added.ts', 'src/live.ts', 'README.md']);
  expect(flattenReviewTree(tree, new Set(['src'])).map((node) => node.path)).toEqual(['src', 'README.md']);
});
