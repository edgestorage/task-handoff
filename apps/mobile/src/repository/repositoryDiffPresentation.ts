import type { RepositoryDiff } from '@task-handoff/protocol/repository';

type DiffLine = RepositoryDiff['lines'][number];

export type ContextDirection = 'up' | 'down';
export type GapExpansion = { fromStart: number; fromEnd: number };
export type ContextControl = { gapId: string; lineCount: number; direction: ContextDirection };
export type ContextControlRow = { kind: 'context-control'; controls: ContextControl[]; hunk?: DiffLine };
export type DiffPresentationRow = DiffLine | ContextControlRow;
export type SplitRow =
  | { kind: 'control'; control: ContextControlRow }
  | { kind: 'full'; line: DiffLine }
  | { kind: 'pair'; oldLine?: DiffLine; newLine?: DiffLine };
export type RepositoryDiffViewMode = 'unified' | 'split';

const contextChunkSize = 20;

export function diffPresentationRows(diff: RepositoryDiff | undefined, expandedGaps: ReadonlyMap<string, GapExpansion>): DiffPresentationRow[] {
  if (!diff) return [];
  const gaps = new Map(diff.contextGaps.map((gap) => [boundaryKey(gap.beforeHunkId, gap.afterHunkId), gap]));
  const rows: DiffPresentationRow[] = [];
  let previousHunkId: string | undefined;
  for (const line of diff.lines) {
    if (line.kind === 'hunk' && line.hunkId) {
      const gap = gaps.get(boundaryKey(previousHunkId, line.hunkId));
      const presentation = gapPresentation(gap, expandedGaps);
      rows.push(...presentation.upperLines);
      if (presentation.controls.length) rows.push({ kind: 'context-control', controls: presentation.controls, hunk: line });
      else rows.push(line);
      rows.push(...presentation.lowerLines);
      previousHunkId = line.hunkId;
      continue;
    }
    rows.push(line);
  }
  if (previousHunkId) {
    const gap = gaps.get(boundaryKey(previousHunkId, undefined));
    const presentation = gapPresentation(gap, expandedGaps);
    rows.push(...presentation.upperLines);
    if (presentation.controls.length) rows.push({ kind: 'context-control', controls: presentation.controls });
    rows.push(...presentation.lowerLines);
  }
  return rows;
}

export function createSplitRows(lines: readonly DiffPresentationRow[]) {
  const rows: SplitRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === 'context-control') {
      rows.push({ kind: 'control', control: line });
      index += 1;
      continue;
    }
    if (line.kind === 'hunk' || line.kind === 'metadata') {
      rows.push({ kind: 'full', line });
      index += 1;
      continue;
    }
    if (line.kind === 'context') {
      rows.push({ kind: 'pair', newLine: line, oldLine: line });
      index += 1;
      continue;
    }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (index < lines.length && (lines[index].kind === 'deletion' || lines[index].kind === 'addition')) {
      const changedLine = lines[index++] as DiffLine;
      if (changedLine.kind === 'deletion') deletions.push(changedLine);
      else if (changedLine.kind === 'addition') additions.push(changedLine);
    }
    rows.push(...alignChangedLines(deletions, additions));
  }
  return rows;
}

function alignChangedLines(deletions: readonly DiffLine[], additions: readonly DiffLine[]): SplitRow[] {
  if (deletions.length > 200 || additions.length > 200) {
    return Array.from({ length: Math.max(deletions.length, additions.length) }, (_, index) => ({ kind: 'pair', newLine: additions[index], oldLine: deletions[index] }));
  }
  const gapCost = 0.55;
  const costs = Array.from({ length: deletions.length + 1 }, () => Array<number>(additions.length + 1).fill(0));
  const operations = Array.from({ length: deletions.length + 1 }, () => Array<'pair' | 'delete' | 'add'>(additions.length + 1).fill('pair'));
  for (let oldIndex = 1; oldIndex <= deletions.length; oldIndex += 1) {
    costs[oldIndex][0] = oldIndex * gapCost;
    operations[oldIndex][0] = 'delete';
  }
  for (let newIndex = 1; newIndex <= additions.length; newIndex += 1) {
    costs[0][newIndex] = newIndex * gapCost;
    operations[0][newIndex] = 'add';
  }
  for (let oldIndex = 1; oldIndex <= deletions.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= additions.length; newIndex += 1) {
      const similarity = lineSimilarity(deletions[oldIndex - 1].content, additions[newIndex - 1].content);
      const pairCost = costs[oldIndex - 1][newIndex - 1] + (similarity >= 0.2 ? 1 - similarity : 1.2);
      const deleteCost = costs[oldIndex - 1][newIndex] + gapCost;
      const addCost = costs[oldIndex][newIndex - 1] + gapCost;
      const best = Math.min(pairCost, deleteCost, addCost);
      costs[oldIndex][newIndex] = best;
      operations[oldIndex][newIndex] = best === pairCost ? 'pair' : best === deleteCost ? 'delete' : 'add';
    }
  }
  const rows: SplitRow[] = [];
  let oldIndex = deletions.length;
  let newIndex = additions.length;
  while (oldIndex || newIndex) {
    const operation = operations[oldIndex][newIndex];
    if (oldIndex && newIndex && operation === 'pair') rows.push({ kind: 'pair', newLine: additions[--newIndex], oldLine: deletions[--oldIndex] });
    else if (oldIndex && (!newIndex || operation === 'delete')) rows.push({ kind: 'pair', oldLine: deletions[--oldIndex] });
    else rows.push({ kind: 'pair', newLine: additions[--newIndex] });
  }
  return rows.reverse();
}

function lineSimilarity(left: string, right: string) {
  const normalizedLeft = left.trim();
  const normalizedRight = right.trim();
  if (normalizedLeft === normalizedRight) return 1;
  const leftTokens = new Set(normalizedLeft.slice(0, 2_000).match(/[\p{L}\p{N}_]+|[^\s]/gu) || []);
  const rightTokens = new Set(normalizedRight.slice(0, 2_000).match(/[\p{L}\p{N}_]+|[^\s]/gu) || []);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

export function expandGap(
  current: ReadonlyMap<string, GapExpansion>,
  gapId: string,
  direction: ContextDirection,
  lineCount: number,
) {
  const next = new Map(current);
  const expansion = next.get(gapId) || { fromStart: 0, fromEnd: 0 };
  next.set(gapId, direction === 'up'
    ? { ...expansion, fromEnd: Math.min(3_000, expansion.fromEnd + lineCount) }
    : { ...expansion, fromStart: Math.min(3_000, expansion.fromStart + lineCount) });
  return next;
}

export function contextLineLimit(expandedGaps: ReadonlyMap<string, GapExpansion>) {
  return Math.min(3_000, Math.max(20, ...[...expandedGaps.values()].flatMap((gap) => [gap.fromStart, gap.fromEnd]).map((value) => value + 20)));
}

export function hasExpandedContext(expandedGaps: ReadonlyMap<string, GapExpansion>) {
  return [...expandedGaps.values()].some((gap) => gap.fromStart > 0 || gap.fromEnd > 0);
}

export function isPatchHeader(line: DiffLine) {
  return line.kind === 'metadata' && /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/.test(line.content);
}

export function diffLineMarker(kind: DiffLine['kind']) {
  if (kind === 'addition') return '+';
  if (kind === 'deletion') return '−';
  return '';
}

export function hunkRange(start: number | undefined, count: number | undefined, noneLabel: string) {
  if (start === undefined || count === undefined) return '';
  if (!count) return noneLabel;
  return count === 1 ? String(start) : `${start}-${start + count - 1}`;
}

function boundaryKey(beforeHunkId: string | undefined, afterHunkId: string | undefined) {
  return `${beforeHunkId || 'start'}\0${afterHunkId || 'end'}`;
}

type ContextGap = RepositoryDiff['contextGaps'][number];

function gapPresentation(gap: ContextGap | undefined, expandedGaps: ReadonlyMap<string, GapExpansion>) {
  if (!gap) return { upperLines: [] as DiffLine[], lowerLines: [] as DiffLine[], controls: [] as ContextControl[] };
  const expansion = expandedGaps.get(gap.gapId) || { fromStart: 0, fromEnd: 0 };
  const startPool = gap.hasMore ? gap.lines.slice(0, gap.startLineCount) : gap.lines;
  const endPool = gap.hasMore ? gap.lines.slice(gap.startLineCount) : gap.lines;
  const upperLines = startPool.slice(0, Math.min(expansion.fromStart, startPool.length));
  const upperKeys = new Set(upperLines.map(diffLineKey));
  const lowerLines = endPool
    .slice(Math.max(0, endPool.length - Math.min(expansion.fromEnd, endPool.length)))
    .filter((line) => !upperKeys.has(diffLineKey(line)));
  const remainingLoaded = gap.lines.length - upperLines.length - lowerLines.length;
  if (!gap.hasMore && remainingLoaded <= 0) return { upperLines, lowerLines, controls: [] as ContextControl[] };
  const lineCount = !gap.hasMore && remainingLoaded <= contextChunkSize ? remainingLoaded : contextChunkSize;
  const controls: ContextControl[] = [];
  if (gap.afterHunkId) controls.push({ gapId: gap.gapId, direction: 'up', lineCount });
  if (gap.beforeHunkId) controls.push({ gapId: gap.gapId, direction: 'down', lineCount });
  return { upperLines, lowerLines, controls };
}

function diffLineKey(line: DiffLine) {
  return `${line.oldLine || 0}:${line.newLine || 0}`;
}
